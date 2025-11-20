// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';

// =====================
// Config
// =====================

const LOCAL_ORIGINS = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
];

const PROD_ORIGINS = [
  'https://mei-go.pages.dev',
];

const CDN_BASE =
  'https://pub-dd5dcc9095b64f479cded9e2d85818d9.r2.dev/assets/v1'; // R2 público

type Bindings = {
  DB: D1Database;
  HF_TOKEN?: string;
  HF2_TOKEN?: string;
  ENV?: string;
  TURNSTILE_SECRET: string;
  FIREBASE_API_KEY?: string;
};

type Env = Bindings;

const app = new Hono<{ Bindings: Bindings }>();

// =====================
// Planes (solo para UI / subs)
// =====================
type PlanId = 'luz' | 'sabiduria' | 'quantico';

/**
 * OJO:
 * PLAN_LIMITS ya NO controla nada real de lecturas.
 * Toda la “capacidad real” viene de los DruCoins.
 * Esto queda como referencia para futuras features o para UI.
 */
const PLAN_LIMITS: Record<PlanId, { monthly: number }> = {
  luz: { monthly: 2 },
  sabiduria: { monthly: 1000000 },
  quantico: { monthly: Number.MAX_SAFE_INTEGER },
} as const;

function nowYm() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getNextResetDate(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

// =====================
// ENV & UTILS
// =====================

function isDevEnv(req: Request, env: Env) {
  return (
    !env.ENV ||
    env.ENV === 'development' ||
    req.url.includes('127.0.0.1') ||
    req.url.includes('localhost')
  );
}

// (Actualmente no se usa en CORS, pero lo dejamos por si se reutiliza)
function getAllowedOrigin(origin: string | null, req: Request, env: Env) {
  if (!origin) return '*';
  const isDev = isDevEnv(req, env);
  const allowed = isDev ? LOCAL_ORIGINS : PROD_ORIGINS;

  // Normaliza equivalentes localhost / 127.0.0.1
  const normalized = origin.replace('127.0.0.1', 'localhost');
  if (allowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized)) {
    return origin; // devuelve exactamente el origin que pidió el browser
  }

  if (!isDev && allowed.includes(origin)) return origin;

  return allowed[0] ?? '*';
}

// =====================
// Roles de usuario
// =====================
const MASTER_USER = 'laife91@gmail.com';

function isMasterUser(email?: string): boolean {
  return email?.toLowerCase() === MASTER_USER;
}

function getUserRole(email?: string): 'master' | 'freemium' | 'guest' {
  if (!email) return 'guest';
  if (isMasterUser(email)) return 'master';
  return 'freemium';
}

// ===================================================
// 🔍 LOGGER GLOBAL: cada request que entra al Worker
// ===================================================
app.use('*', async (c, next) => {
  try {
    const req = c.req.raw;
    console.groupCollapsed(
      '%c🚀 REQUEST IN',
      'color:#00e5ff;font-weight:bold;'
    );
    console.log('Method:', req.method);
    console.log('URL:', req.url);

    const headersObj: Record<string, string> = {};
    req.headers.forEach((v, k) => (headersObj[k] = v));
    console.log('Headers:', headersObj);
    console.log('ENV.ENV:', (c.env as any)?.ENV || 'undefined');
    console.groupEnd();
  } catch (err) {
    console.error('⚠️ Error en logger global:', err);
  }

  await next();
});

// =====================
// CORS (global)
// =====================
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const env = c.env as Env;
      const isDev = !env.ENV || env.ENV === 'development';

      // En desarrollo permite localhost
      if (isDev) {
        const localAllowed = ['http://localhost:4200', 'http://127.0.0.1:4200'];
        const incoming = origin || localAllowed[0];

        const normalized = incoming.replace('127.0.0.1', 'localhost');
        const ok = localAllowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized);

        const resolved = ok ? incoming : localAllowed[0];
        console.log('🌐 [CORS DEV] origin:', origin, '→', resolved);
        return resolved;
      }

      // En producción permitir:
      //   - dominio principal
      //   - cualquier preview *.mei-go.pages.dev
      const incoming = origin || 'https://mei-go.pages.dev';

      if (incoming === 'https://mei-go.pages.dev') {
        console.log('🌐 [CORS PROD] main origin accepted:', incoming);
        return incoming;
      }

      if (incoming.endsWith('.mei-go.pages.dev')) {
        console.log('🌐 [CORS PROD] preview origin accepted:', incoming);
        return incoming;
      }

      console.warn('🚫 [CORS PROD] origin bloqueado:', incoming);
      return 'https://mei-go.pages.dev';
    },

    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true, 
    maxAge: 86400,
  })
);

// =====================
// User + “Plan” (solo para snapshot de sesión)
// =====================

async function ensureUserPlan(env: Env, uid: string): Promise<PlanId> {
  console.groupCollapsed(
    '%c👤 ensureUserPlan()',
    'color:#4caf50;font-weight:bold;'
  );
  console.log('UID:', uid);

  const row = await env.DB.prepare('SELECT plan FROM users WHERE uid=?')
    .bind(uid)
    .first<{ plan: string }>();

  if (row?.plan) {
    console.log('Plan existente:', row.plan);
    console.groupEnd();
    return row.plan as PlanId;
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO users(uid, email, plan, created_at, updated_at) VALUES(?,?,?,?,?)'
  )
    .bind(uid, null, 'luz', Date.now(), Date.now())
    .run();

  console.log('Plan inicial asignado: luz');
  console.groupEnd();
  return 'luz';
}

/**
 * ⚠️ IMPORTANTE
 * A partir de ahora, la “quota” NO controla nada real.
 * Solo se calcula desde el balance de DruCoins para que el frontend
 * siga recibiendo un objeto quota sin romperse.
 */
async function getUserQuotaState(env: Env, uid: string) {
  console.groupCollapsed(
    '%c📊 getUserQuotaState() [VIRTUAL]',
    'color:#03a9f4;font-weight:bold;'
  );
  console.log('UID:', uid);

  const plan = await ensureUserPlan(env, uid);
  const drucoins = await getDrucoinBalance(env, uid);

  const monthly = drucoins;   // valor virtual
  const used = 0;             // siempre 0 en esta nueva lógica
  const remaining = drucoins; // 1 DruCoin = 1 “lectura posible”

  const state = {
    plan,
    monthly,
    used,
    remaining,
    nextResetDate: getNextResetDate(),
  };

  console.log('Estado virtual de quota basado en DruCoins:', state);
  console.groupEnd();
  return state;
}

// =====================
// 🚫 SISTEMA DE QUOTAS: AHORA SOLO “STUBS”
// =====================

/**
 * Antes consumía quota real de la tabla `quotas`.
 * Ahora SIEMPRE devuelve true (no limita nada).
 * La lógica real de límite depende SOLO de los DruCoins.
 */
async function checkAndConsumeQuota(_env: Env, uid: string): Promise<boolean> {
  console.groupCollapsed(
    '%c🧮 checkAndConsumeQuota() [STUB]',
    'color:#9e9e9e;font-weight:bold;'
  );
  console.log('UID:', uid, '→ siempre true (solo DruCoins mandan ahora)');
  console.groupEnd();
  return true;
}

/**
 * Antes descontaba “used” en quotas.
 * Ahora se ignora: dejamos el stub para no romper código viejo.
 */
async function addQuotaCredits(_env: Env, uid: string, amount: number) {
  console.groupCollapsed(
    '%c➕ addQuotaCredits() [STUB]',
    'color:#9e9e9e;font-weight:bold;'
  );
  console.log('UID:', uid, 'amount:', amount, '→ ignorado (cuota deprecated)');
  console.groupEnd();
}

/**
 * Antes reseteaba la quota según el plan.
 * Ahora es un NO-OP, se deja para subs y compatibilidad.
 */
async function resetQuotaForPlan(_env: Env, uid: string, plan: PlanId) {
  console.groupCollapsed(
    '%c🔁 resetQuotaForPlan() [STUB]',
    'color:#9e9e9e;font-weight:bold;'
  );
  console.log('UID:', uid, 'plan:', plan, '→ no se toca ninguna tabla de quota');
  console.groupEnd();
}

// =====================
// 💰 DRUCOINS
// =====================

let drucoinTableReady = false;

async function ensureDrucoinTable(env: Env) {
  if (drucoinTableReady) return;
  console.groupCollapsed(
    '%c🏗 ensureDrucoinTable()',
    'color:#ffb300;font-weight:bold;'
  );
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS drucoins (
      uid TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )
  `).run();
  drucoinTableReady = true;
  console.log('Tabla drucoins asegurada.');
  console.groupEnd();
}

async function ensureDrucoinWallet(env: Env, uid: string) {
  console.groupCollapsed(
    '%c👛 ensureDrucoinWallet()',
    'color:#ffa000;font-weight:bold;'
  );
  console.log('UID:', uid);
  await ensureDrucoinTable(env);

  // 👇 aquí pones el saldo inicial que quieras (2)
  await env.DB.prepare(
    'INSERT OR IGNORE INTO drucoins(uid, balance, updated_at) VALUES(?,?,?)'
  )
    .bind(uid, 2, Date.now())
    .run();

  console.groupEnd();
}


async function getDrucoinBalance(env: Env, uid: string): Promise<number> {
  console.groupCollapsed(
    '%c📟 getDrucoinBalance()',
    'color:#ff9800;font-weight:bold;'
  );
  console.log('UID:', uid);
  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare('SELECT balance FROM drucoins WHERE uid=?')
    .bind(uid)
    .first<{ balance: number }>();
  const balance = row?.balance ?? 0;
  console.log('Balance actual:', balance);
  console.groupEnd();
  return balance;
}

async function addDrucoins(env: Env, uid: string, amount: number): Promise<number> {
  console.groupCollapsed(
    '%c💎 addDrucoins()',
    'color:#ff7043;font-weight:bold;'
  );
  console.log('UID:', uid, 'amount:', amount);
  if (amount <= 0) {
    console.log('amount <= 0 → no se modifica balance.');
    const current = await getDrucoinBalance(env, uid);
    console.groupEnd();
    return current;
  }
  await ensureDrucoinWallet(env, uid);
  const sql = await env.DB.prepare(
    'UPDATE drucoins SET balance = balance + ?, updated_at=? WHERE uid=?'
  )
    .bind(amount, Date.now(), uid)
    .run();
  console.log('UPDATE resultado:', sql);
  const balance = await getDrucoinBalance(env, uid);
  console.log('Balance después de sumar:', balance);
  console.groupEnd();
  return balance;
}

async function useDrucoins(env: Env, uid: string, amount = 1): Promise<boolean> {
  console.groupCollapsed(
    '%c💸 useDrucoins()',
    'color:#ff5722;font-weight:bold;'
  );
  console.log('UID:', uid, 'amount:', amount);

  if (amount <= 0) {
    console.log('amount <= 0 → no se descuenta nada, devolvemos true.');
    console.groupEnd();
    return true;
  }

  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare('SELECT balance FROM drucoins WHERE uid=?')
    .bind(uid)
    .first<{ balance: number }>();

  const balance = row?.balance ?? 0;
  console.log('Balance BEFORE:', balance);

  if (balance < amount) {
    console.warn('❌ Balance insuficiente para descontar DruCoins.');
    console.groupEnd();
    return false;
  }

  const sql = await env.DB.prepare(
    'UPDATE drucoins SET balance = balance - ?, updated_at=? WHERE uid=?'
  )
    .bind(amount, Date.now(), uid)
    .run();
  console.log('UPDATE resultado:', sql);

  const newBalance = await getDrucoinBalance(env, uid);
  console.log('Balance AFTER:', newBalance);
  console.groupEnd();
  return true;
}

// =====================
// 🔐 Verificación de token Firebase (se usa en varias rutas)
// =====================
async function verifyFirebaseIdToken(idToken: string, apiKey: string) {
  console.groupCollapsed(
    '%c🔑 verifyFirebaseIdToken()',
    'color:#26a69a;font-weight:bold;'
  );
  console.log('idToken.length:', idToken?.length || 0);

  const resp = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error('❌ Firebase getAccountInfo error:', resp.status, text);
    console.groupEnd();
    throw new Error('invalid_token');
  }

  const data = await resp.json();
  const user = data?.users?.[0];
  if (!user) {
    console.error('❌ Firebase getAccountInfo sin usuario.');
    console.groupEnd();
    throw new Error('invalid_token');
  }

  const out = {
    uid: user.localId,
    email: (user.email || '').toLowerCase(),
  };

  console.log('Usuario verificado:', out);
  console.groupEnd();
  return out;
}

// =====================
// 🚦 Lógica de permiso para lectura (solo DruCoins)
// =====================

type ReadingBlockReason = 'drucoins';

async function canDoReading(
  env: Env,
  uid: string,
  opts?: { isMaster?: boolean }
): Promise<{ allowed: boolean; reason?: ReadingBlockReason }> {
  console.groupCollapsed(
    '%c🧙 canDoReading()',
    'color:#ab47bc;font-weight:bold;'
  );
  console.log('UID:', uid, 'opts:', opts);

  // Master user siempre permitido
  if (opts?.isMaster) {
    console.log('Rol: MASTER → permitido sin límites.');
    console.groupEnd();
    return { allowed: true };
  }

  // Invitado/guest: de momento permitido sin límite real
  if (!uid || uid === 'guest') {
    console.log('UID guest → permitido (sin control de DruCoins).');
    console.groupEnd();
    return { allowed: true };
  }

  const balance = await getDrucoinBalance(env, uid);
  console.log('DruCoins actuales:', balance);

  if (balance <= 0) {
    console.warn('⛔ Bloqueado por falta de DruCoins.');
    console.groupEnd();
    return { allowed: false, reason: 'drucoins' };
  }

  console.log('✅ Puede hacer lectura (tiene DruCoins).');
  console.groupEnd();
  return { allowed: true };
}

// =====================
// /api/quota (virtual, basado en DruCoins)
// =====================
app.get('/api/quota', async (c) => {
  console.groupCollapsed(
    '%c📡 /api/quota',
    'color:#42a5f5;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    console.log('Auth header presente:', !!token);

    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const quota = await getUserQuotaState(c.env, uid);

    console.log('Quota virtual enviada al cliente:', quota);
    console.groupEnd();
    return c.json({ ok: true, quota });
  } catch (err: any) {
    console.error('💥 /api/quota error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// =====================
// Subscriptions + DruCoins
// =====================

app.post('/api/subscriptions/check', async (c) => {
  console.groupCollapsed(
    '%c🧾 /api/subscriptions/check',
    'color:#7e57c2;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    console.log('Auth header presente:', !!token);

    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const quota = await getUserQuotaState(c.env, uid);
    const drucoins = await getDrucoinBalance(c.env, uid);

    const payload = {
      ok: true,
      plan: quota.plan,
      isLuz: quota.plan === 'luz',
      isSabiduria: quota.plan === 'sabiduria',
      isQuantico: quota.plan === 'quantico',
      hasDonations: drucoins > 0,
      drucoins,
      quota,
    };

    console.log('Respuesta /subscriptions/check:', payload);
    console.groupEnd();
    return c.json(payload);
  } catch (err: any) {
    console.error('💥 /api/subscriptions/check error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

async function setUserPlan(env: Env, uid: string, plan: PlanId) {
  console.groupCollapsed(
    '%c📌 setUserPlan()',
    'color:#5c6bc0;font-weight:bold;'
  );
  console.log('UID:', uid, 'plan:', plan);
  await ensureUserPlan(env, uid);
  const sql = await env.DB.prepare(
    'UPDATE users SET plan = ?, updated_at=? WHERE uid=?'
  )
    .bind(plan, Date.now(), uid)
    .run();
  console.log('UPDATE users resultado:', sql);
  console.groupEnd();
}

app.post('/api/subscriptions/sabiduria/activate', async (c) => {
  console.groupCollapsed(
    '%c🌙 /api/subscriptions/sabiduria/activate',
    'color:#ffca28;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    await setUserPlan(c.env, uid, 'sabiduria');
    // resetQuotaForPlan es ahora un STUB (no toca nada real)
    await resetQuotaForPlan(c.env, uid, 'sabiduria');

    const balance = await addDrucoins(c.env, uid, 30);

    const resp = { ok: true, plan: 'sabiduria' as const, balance };
    console.log('Respuesta sabiduria/activate:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/subscriptions/sabiduria error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.post('/api/subscriptions/premium/activate', async (c) => {
  console.groupCollapsed(
    '%c🌌 /api/subscriptions/premium/activate',
    'color:#ff7043;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    await setUserPlan(c.env, uid, 'quantico');
    await resetQuotaForPlan(c.env, uid, 'quantico');

    const balance = await addDrucoins(c.env, uid, 60);

    const resp = {
      ok: true,
      message: 'Pronto daremos más información en nuestro vlog.',
      plan: 'quantico' as const,
      balance,
    };
    console.log('Respuesta premium/activate:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/subscriptions/premium error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

// =====================
// Endpoints DruCoins
// =====================

app.post('/api/drucoins/add', async (c) => {
  console.groupCollapsed(
    '%c🪙 /api/drucoins/add',
    'color:#8bc34a;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 0 } = await c.req
      .json<{ amount?: number }>()
      .catch(() => ({ amount: 0 }));

    console.log('Payload amount:', amount);

    if (!amount || amount <= 0) {
      console.warn('amount inválido:', amount);
      console.groupEnd();
      return c.json({ ok: false, error: 'invalid_amount' }, 400);
    }

    // Antes: también se daban créditos de quota → ahora se ignora
    await addQuotaCredits(c.env, uid, 2);

    const donationCoins = 2;
    const balance = await addDrucoins(c.env, uid, donationCoins);

    const resp = { ok: true, balance, granted: donationCoins };
    console.log('Respuesta drucoins/add:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/drucoins/add error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.post('/api/drucoins/purchase', async (c) => {
  console.groupCollapsed(
    '%c💳 /api/drucoins/purchase',
    'color:#cddc39;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 0 } = await c.req
      .json<{ amount?: number }>()
      .catch(() => ({ amount: 0 }));

    console.log('Payload amount:', amount);

    const packs: Record<number, number> = { 1: 2, 2: 5, 5: 15 };
    const granted = packs[amount] ?? 0;
    if (!granted) {
      console.warn('amount no válido para pack:', amount);
      console.groupEnd();
      return c.json({ ok: false, error: 'invalid_amount' }, 400);
    }

    const balance = await addDrucoins(c.env, uid, granted);
    const resp = { ok: true, balance, granted };

    console.log('Respuesta drucoins/purchase:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/drucoins/purchase error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.post('/api/drucoins/use', async (c) => {
  console.groupCollapsed(
    '%c⚖️ /api/drucoins/use',
    'color:#ff9800;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 1 } = await c.req
      .json<{ amount?: number }>()
      .catch(() => ({ amount: 1 }));

    console.log('Solicitud de uso amount:', amount);

    const okUse = await useDrucoins(c.env, uid, amount || 1);
    if (!okUse) {
      const balance = await getDrucoinBalance(c.env, uid);
      const resp402 = {
        ok: false,
        error: 'sin_drucoins',
        message: 'Sin drucoins suficientes.',
        balance,
      };
      console.warn('Respuesta 402 /drucoins/use:', resp402);
      console.groupEnd();
      return c.json(resp402, 402);
    }

    const balance = await getDrucoinBalance(c.env, uid);
    const resp = { ok: true, balance };
    console.log('Respuesta ok /drucoins/use:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/drucoins/use error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.get('/api/drucoins/balance', async (c) => {
  console.groupCollapsed(
    '%c📈 /api/drucoins/balance',
    'color:#00bcd4;font-weight:bold;'
  );
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      console.warn('❌ Sin token → 401');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const balance = await getDrucoinBalance(c.env, uid);
    const resp = { ok: true, balance };
    console.log('Respuesta /drucoins/balance:', resp);
    console.groupEnd();
    return c.json(resp);
  } catch (err: any) {
    console.error('💥 /api/drucoins/balance error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

// ============= AQUÍ TERMINA LA PARTE 1/4 =============
// En la siguiente parte metemos:
// - debug/version, auth demo, captcha
// - Términos & sesión (/session/validate, /terms/*)
// - + más endpoints

// ============================================================
// VERSION
// ============================================================
app.get('/api/version', (c) => {
  console.groupCollapsed(
    '%c🧭 /api/version',
    'color:#4dd0e1;font-weight:bold;'
  );
  const payload = {
    ok: true,
    version: '1.0.0-meigo',
    env: c.env.ENV || 'undefined',
  };
  console.log('payload:', payload);
  console.groupEnd();
  return c.json(payload);
});

// ============================================================
// AUTH DEMO (para modo prueba sin Firebase)
// ============================================================
app.post('/api/auth/demo', async (c) => {
  console.groupCollapsed(
    '%c🎭 /api/auth/demo',
    'color:#7e57c2;font-weight:bold;'
  );

  const user = {
    uid: 'demo-user',
    email: 'demo@meigo.app',
  };

  const resp = { ok: true, user };
  console.log('Demo user devuelto:', resp);

  console.groupEnd();
  return c.json(resp);
});

// ============================================================
// TURNSTILE CAPTCHA
// ============================================================
async function verifyTurnstile(token: string, env: Env) {
  console.groupCollapsed(
    '%c🛡 verifyTurnstile()',
    'color:#81c784;font-weight:bold;'
  );
  console.log('token:', token);

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });

  const data = await resp.json();
  console.log('Respuesta turnstile:', data);

  console.groupEnd();
  return data;
}

app.post('/api/captcha/verify', async (c) => {
  console.groupCollapsed(
    '%c🛡 /api/captcha/verify',
    'color:#4caf50;font-weight:bold;'
  );

  const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: '' }));
  console.log('token recibido:', token);

  if (!token) {
    console.warn('❌ token vacío');
    console.groupEnd();
    return c.json({ ok: false, error: 'missing_token' }, 400);
  }

  const data = await verifyTurnstile(token, c.env);
  const ok = !!data.success;

  console.log('Resultado final:', ok ? '✓ válido' : '✗ inválido');
  console.groupEnd();
  return c.json({ ok });
});

// ============================================================
// TERMS & CONDITIONS
// ============================================================

// ¿Necesita aceptar términos?
app.get('/api/terms/needs', async (c) => {
  console.groupCollapsed(
    '%c📜 /api/terms/needs',
    'color:#ffb74d;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ sin token');
      console.groupEnd();
      return c.json({ needs: true }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    console.log('UID:', uid);

    const row = await c.env.DB.prepare(
      'SELECT accepted_at FROM terms_acceptance WHERE uid=?'
    )
      .bind(uid)
      .first<{ accepted_at: number }>();

    console.log('Row DB:', row);

    const needs = !row;
    console.log('needsTerms:', needs);

    console.groupEnd();
    return c.json({ needs });
  } catch (err) {
    console.error('💥 /terms/needs error:', err);
    console.groupEnd();
    return c.json({ needs: true }, 401);
  }
});

// Check terms (GET corregido)
app.get('/api/terms/check', async (c) => {
  console.groupCollapsed(
    '%c📜 /api/terms/check',
    'color:#ff9800;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ sin token');
      console.groupEnd();
      return c.json({ accepted: false }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    const row = await c.env.DB.prepare(
      'SELECT accepted_at FROM terms_acceptance WHERE uid=?'
    )
      .bind(uid)
      .first<{ accepted_at: number }>();

    console.log('Row:', row);

    const accepted = !!row;
    console.log('accepted:', accepted);

    console.groupEnd();
    return c.json({ accepted });
  } catch (err) {
    console.error('💥 /terms/check error:', err);
    console.groupEnd();
    return c.json({ accepted: false }, 401);
  }
});

// Aceptar términos (graba la fecha y REGALA 1 DRUCOIN)
app.post('/api/terms/accept', async (c) => {
  console.groupCollapsed(
    '%c📝 /api/terms/accept',
    'color:#ff7043;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ sin token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    console.log('Aceptando términos para UID:', uid);

    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO terms_acceptance(uid, accepted_at) VALUES(?,?)'
    )
      .bind(uid, now)
      .run();

    console.log('Términos guardados.');

    // ⭐ RECOMPENSA: 1 DruCoin
    const balance = await addDrucoins(c.env, uid, 1);
    console.log('Balance después del bonus:', balance);

    const resp = { ok: true, balance };
    console.log('Respuesta final:', resp);

    console.groupEnd();
    return c.json(resp);
  } catch (err) {
    console.error('💥 /terms/accept error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});

// ============================================================
// SESSION VALIDATE
// ============================================================

app.get('/api/session/validate', async (c) => {
  console.groupCollapsed(
    '%c🔐 /api/session/validate',
    'color:#29b6f6;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!token) {
      console.warn('❌ sin token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    // Firebase
    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;
    const email = user.email;

    console.log('Usuario:', user);

    // Plan (solo UI)
    const plan = await ensureUserPlan(c.env, uid);

    // DruCoins reales
    const drucoins = await getDrucoinBalance(c.env, uid);
    console.log('DruCoins:', drucoins);

    // Quota virtual basada en DruCoins
    const quota = await getUserQuotaState(c.env, uid);

    // ¿Ha aceptado términos?
    const row = await c.env.DB.prepare(
      'SELECT accepted_at FROM terms_acceptance WHERE uid=?'
    )
      .bind(uid)
      .first<{ accepted_at: number }>();

    const needsTerms = !row;
    console.log('needsTerms:', needsTerms);

    const resp = {
      ok: true,
      uid,
      email,
      plan,
      drucoins,
      quota,
      needsTerms,
    };

    console.log('Respuesta /session/validate:', resp);

    console.groupEnd();
    return c.json(resp);
  } catch (err) {
    console.error('💥 /session/validate error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ============= AQUÍ TERMINA LA PARTE 2/4 =============


// ============================================================
// TAROT — SPREADS DEFINITIONS
// ============================================================
app.get('/api/spreads', (c) => {
  console.groupCollapsed(
    '%c🎴 /api/spreads',
    'color:#ab47bc; font-weight:bold;'
  );

  const spreads = [
    {
      id: 'celtic-cross-10',
      name: 'Cruz Celta (10)',
      positions: Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        label: `Pos ${i + 1}`,
        allowsReversed: true,
      })),
    },
    {
      id: 'ppf-3',
      name: 'Pasado · Presente · Futuro',
      positions: [1, 2, 3].map((i) => ({
        index: i,
        label: `${i}`,
        allowsReversed: true,
      })),
    },
    {
      id: 'free',
      name: 'Libre (9)',
      positions: Array.from({ length: 9 }, (_, i) => ({
        index: i + 1,
        label: `${i + 1}`,
        allowsReversed: true,
      })),
    },
  ];

  console.log('Spreads enviados:', spreads);
  console.groupEnd();

  return c.json(spreads);
});

// ============================================================
// TAROT — DECK (ABSOLUTE URL)
// ============================================================
app.get('/api/decks', (c) => {
  console.groupCollapsed(
    '%c🃏 /api/decks',
    'color:#26c6da;font-weight:bold;'
  );

  const origin = new URL(c.req.url).origin;

  const deckAbs = FULL_DECK.map((m) => ({
    ...m,
    imageUrl: new URL(m.imageUrl, origin).toString(),
  }));

  console.log('Deck size:', deckAbs.length);
  console.groupEnd();

  return c.json(deckAbs);
});

// ============================================================
// SEED / RNG HELPERS FOR DRAW
// ============================================================
const hashSeed = (s: string) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

function rng32(seed: number) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };
}

// ============================================================
// 🔥 DRAW — TIRADAS DE CARTAS (SIN CUOTAS, GRATIS SIEMPRE)
// ============================================================
app.post('/api/draw', async (c) => {
  console.groupCollapsed(
    '%c🔮 /api/draw',
    'color:#ffca28;font-weight:bold;'
  );

  try {
    // Autenticación Firebase opcional
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let uid = 'guest';
    let email = 'guest';
    let isMaster = false;

    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
        email = verified.email;
        isMaster = isMasterUser(email);
      } catch (err) {
        console.warn('⚠ Token inválido en /draw:', err);
      }
    }

    console.log('UID:', uid);
    console.log('Email:', email);
    console.log('Master:', isMaster);

    // Body
    const body = (await c.req.json().catch(() => ({}))) as {
      spreadId?: string;
      seed?: string;
      context?: string;
      allowsReversed?: boolean;
    };

    const spreadId = body.spreadId ?? 'celtic-cross-10';
    const seedInput = body.seed ?? Date.now().toString();
    const allowsReversed = body.allowsReversed ?? true;

    console.log('Spread:', spreadId);
    console.log('Seed input:', seedInput);

    // Número de cartas
    const count =
      spreadId === 'ppf-3' ? 3 :
      spreadId === 'free' ? 9 : 10;

    console.log('Cards count:', count);

    // Generar semilla
    const seedNum = hashSeed(seedInput);
    const rnd = rng32(seedNum);

    // Shuffle
    const ids = FULL_DECK.map((d) => d.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    const selected = ids.slice(0, count);

    const cards = selected.map((id, index) => ({
      position: index + 1,
      cardId: id,
      reversed: allowsReversed ? rnd() < 0.4 : false,
    }));

    console.log('Cards selected:', cards);

    // Guardar tirada (si NO es guest)
    if (uid !== 'guest') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        await c.env.DB.prepare(
          `INSERT INTO draws(uid, email, day, spreadId, context, cards_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(uid, email, today, spreadId, body.context || '', JSON.stringify(cards))
          .run();

        console.log('Tirada guardada en DB:', today);
      } catch (err) {
        console.warn('⚠ No se pudo guardar la tirada:', err);
      }
    }

    const resp = {
      ok: true,
      spreadId,
      seed: seedInput,
      uid,
      cards,
      remaining: '∞', // ya que NO hay cuotas
    };

    console.log('Respuesta final /draw:', resp);

    console.groupEnd();
    return c.json(resp);
  } catch (err) {
    console.error('💥 /api/draw ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: 'internal_error', message: String(err) }, 500);
  }
});

// ============================================================
// HISTORY SAVE
// ============================================================
app.post('/api/history/save', async (c) => {
  console.groupCollapsed(
    '%c💾 /api/history/save',
    'color:#4db6ac;font-weight:bold;'
  );

  try {
    const { id, spreadId, spreadLabel, cards, ts } =
      await c.req.json().catch(() => ({}));

    console.log('Body recibido:', { id, spreadId, spreadLabel, ts });

    // Auth
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    let uid = 'guest';
    let email = 'guest';

    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const v = await verifyFirebaseIdToken(token, apiKey);
        uid = v.uid;
        email = v.email;
      } catch {
        console.warn('⚠ Token inválido al guardar history');
        console.groupEnd();
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
    }

    if (uid === 'guest') {
      console.warn('❌ guest no puede guardar historial');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    await c.env.DB.prepare(
      `INSERT INTO history(id, uid, spreadId, spreadLabel, cards_json, ts)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(id, uid, spreadId, spreadLabel, JSON.stringify(cards), ts ?? Date.now())
      .run();

    console.log('Historial guardado OK.');

    console.groupEnd();
    return c.json({ ok: true });
  } catch (err) {
    console.error('💥 /history/save error:', err);
    console.groupEnd();
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

// ============================================================
// HISTORY LIST
// ============================================================
app.get('/api/history/list', async (c) => {
  console.groupCollapsed(
    '%c📚 /api/history/list',
    'color:#4fc3f7;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!token) {
      console.warn('❌ sin token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;

    console.log('UID:', uid);

    const rows = await c.env.DB.prepare(
      `SELECT id, spreadId, spreadLabel, cards_json, ts
       FROM history
       WHERE uid = ?
       ORDER BY ts DESC
       LIMIT 50`
    )
      .bind(uid)
      .all();

    const history =
      rows.results?.map((r) => ({
        id: r.id,
        spreadId: r.spreadId,
        spreadLabel: r.spreadLabel,
        cards: JSON.parse(r.cards_json || '[]'),
        ts: Number(r.ts),
      })) ?? [];

    console.log('History size:', history.length);

    console.groupEnd();
    return c.json({ ok: true, history });
  } catch (err) {
    console.error('💥 /history/list error:', err);
    console.groupEnd();
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

// ============= AQUÍ TERMINA LA PARTE 3/4 =============

// ============================================================
// CARD MEANING — SIGNIFICADO INDIVIDUAL DE UNA CARTA
// ============================================================
app.post('/api/card-meaning', async (c) => {
  console.groupCollapsed(
    '%c🔎 /api/card-meaning',
    'color:#ba68c8;font-weight:bold;'
  );

  try {
    const { name, reversed } = await c.req.json();
    console.log('Carta solicitada:', name, 'Reversed:', reversed);

    const token = c.env.HF_TOKEN;
    if (!token) {
      console.warn('❌ No HF_TOKEN configurado');
      console.groupEnd();
      return c.json({ ok: false, error: 'no_token' }, 401);
    }

    const prompt = `
Eres un intérprete experto de tarot celta.
Explica la carta **${name}** ${reversed ? '(invertida)' : ''} en 2 párrafos cortos.
No incluyas despedidas, emojis ni texto redundante.
`;

    console.log('Prompt generado:', prompt);

    const response = await fetch(
      'https://router.huggingface.co/featherless-ai/v1/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.1-8B-Instruct',
          prompt,
          max_tokens: 300,
          temperature: 0.7,
        }),
      }
    );

    if (!response.ok) {
      const txt = await response.text();
      console.error('❌ HF error:', response.status, txt);
      console.groupEnd();
      return c.json({ ok: false, error: txt });
    }

    const result = await response.json();
    const output = result?.choices?.[0]?.text?.trim() || '';

    console.log('Significado final:', output);

    console.groupEnd();
    return c.json({ ok: true, meaning: output });
  } catch (err) {
    console.error('💥 /api/card-meaning ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// 🔥🔥🔥 INTERPRETACIÓN COMPLETA DE TIRADA (IA + DRUCOINS)
// ============================================================
app.post('/api/interpret', async (c) => {
  console.groupCollapsed(
    '%c💫 /api/interpret',
    'color:#ff5252;font-weight:bold;'
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    // -----------------------------------
    // BODY
    // -----------------------------------
    const { context, cards, spreadId } = await c.req.json();
    console.log('Contexto recibido:', context);
    console.log('Cartas recibidas:', cards);
    console.log('Spread:', spreadId);

    // -----------------------------------
    // AUTH
    // -----------------------------------
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!token) {
      console.warn('❌ No token enviado');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;
    const email = v.email;

    console.log('Usuario:', uid, email);

    const isMaster = isMasterUser(email);
    console.log('¿Master?', isMaster);

    // -----------------------------------
    // DRUCOINS VALIDATION
    // -----------------------------------
    if (!isMaster) {
      const before = await getDrucoinBalance(c.env, uid);
      console.log('DruCoins BEFORE:', before);

      if (before <= 0) {
        console.warn('❌ Sin DruCoins suficientes');
        console.groupEnd();
        return c.json(
          {
            ok: false,
            error: 'NO_DRUCOINS',
            message: 'No tienes DruCoins suficientes.',
            drucoins: before,
          },
          402
        );
      }

      // Descuento
      const okUse = await useDrucoins(c.env, uid, 1);
      if (!okUse) {
        console.warn('❌ Falla al descontar DruCoins');
        const bal = await getDrucoinBalance(c.env, uid);
        console.groupEnd();
        return c.json({
          ok: false,
          error: 'NO_DRUCOINS',
          drucoins: bal,
        }, 402);
      }

      const after = await getDrucoinBalance(c.env, uid);

      console.groupCollapsed(
        '%c💰 DruCoins descontados',
        'color:#ff7043;font-weight:bold;'
      );
      console.log('Antes:', before);
      console.log('Después:', after);
      console.groupEnd();
    }

    // -----------------------------------
    // BUILD PROMPT
    // -----------------------------------
    const spreadLabel =
      spreadId === 'celtic-cross-10'
        ? 'Cruz Celta (10 cartas)'
        : spreadId === 'ppf-3'
        ? 'Pasado · Presente · Futuro'
        : 'Tirada libre';

    const formattedCards = cards.map((c) =>
      `${cardNamesEs[c.name] || c.name}${c.reversed ? ' (invertida)' : ''}`
    );

    const prompt = `
Eres un guía espiritual celta. Usa frases breves y claras (máx 2–3 líneas cada párrafo).
NO repitas ideas. NO cierres con despedidas.

Tirada: ${spreadLabel}
Contexto del consultante: "${context || 'Sin contexto'}"

Cartas:
${formattedCards.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Tareas:
1. Explica el mensaje central.
2. Resume la energía de cada carta.
3. Finaliza con UNA sola frase sabia.
`;

    console.log('Prompt final:', prompt);

    // -----------------------------------
    // LLAMADA A HUGGINGFACE
    // -----------------------------------
    const hfToken = c.env.HF_TOKEN;
    if (!hfToken) {
      console.warn('❌ No HF_TOKEN');
      console.groupEnd();
      return c.json({ ok: false, error: 'no_token' }, 401);
    }

    const response = await fetch(
      'https://router.huggingface.co/featherless-ai/v1/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.1-8B-Instruct',
          prompt,
          max_tokens: 900,
          temperature: 0.65,
          top_p: 0.85,
        }),
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error('❌ HF error:', response.status, text);
      console.groupEnd();
      return c.json({ ok: false, error: text });
    }

    const result = await response.json();

    let interpretation = result?.choices?.[0]?.text?.trim() || '';
    console.log('Interpretación bruta:', interpretation);

    // Limpieza
    interpretation = interpretation
      .replace(/(Gracias[^]+$)/i, '')
      .replace(/(\*\*.*Licencia.*$)/i, '')
      .replace(/\*{3,}/g, '**')
      .trim();

    console.log('Interpretación final limpia:', interpretation);

    const resp = {
      ok: true,
      interpretation,
      drucoins: await getDrucoinBalance(c.env, uid),
    };

    console.log('Respuesta final /interpret:', resp);

    console.groupEnd();
    return c.json(resp);
  } catch (err) {
    console.error('💥 /api/interpret ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// READINGS — SAVE
// ============================================================
app.post('/api/readings/save', async (c) => {
  console.groupCollapsed(
    '%c📝 /api/readings/save',
    'color:#64b5f6;font-weight:bold;'
  );

  try {
    const { title, interpretation, cards, spreadId } = await c.req.json();
    console.log('Body:', { title, spreadId });

    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ No token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;
    const email = v.email;

    console.log('Usuario:', uid, email);

    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO readings(id,uid,email,title,interpretation,cards_json,spreadId,created_at)
       VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    )
      .bind(id, uid, email, title, interpretation, JSON.stringify(cards), spreadId)
      .run();

    console.log('Lectura guardada:', id);

    console.groupEnd();
    return c.json({ ok: true, id });
  } catch (err) {
    console.error('💥 /readings/save ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// READINGS — LIST
// ============================================================
app.get('/api/readings/list', async (c) => {
  console.groupCollapsed(
    '%c📚 /api/readings/list',
    'color:#4dd0e1;font-weight:bold;'
  );

  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ No token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;

    console.log('UID:', uid);

    const rows = await c.env.DB.prepare(
      `SELECT id, title, strftime('%s', created_at) AS created_at
       FROM readings
       WHERE uid = ?
       ORDER BY datetime(created_at) DESC`
    )
      .bind(uid)
      .all();

    const items =
      rows.results?.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: Number(r.created_at) * 1000,
      })) ?? [];

    console.log('Lecturas encontradas:', items);

    console.groupEnd();
    return c.json({ ok: true, items });
  } catch (err) {
    console.error('💥 /readings/list ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// READINGS — GET BY ID
// ============================================================
app.get('/api/readings/:id', async (c) => {
  console.groupCollapsed(
    '%c📘 /api/readings/:id',
    'color:#4fc3f7;font-weight:bold;'
  );

  try {
    const id = c.req.param('id');
    console.log('Reading ID solicitado:', id);

    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ No token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;

    console.log('UID:', uid);

    const row = await c.env.DB.prepare(
      `SELECT id,title,interpretation,cards_json,spreadId,
              strftime('%s',created_at) AS created_at
       FROM readings
       WHERE id=? AND uid=?`
    )
      .bind(id, uid)
      .first();

    if (!row) {
      console.warn('❌ lectura no encontrada');
      console.groupEnd();
      return c.json({ ok: false, error: 'not_found' }, 404);
    }

    let cards: any[] = [];
    try {
      cards = row.cards_json ? JSON.parse(row.cards_json) : [];
    } catch {}

    const result = {
      ok: true,
      id: row.id,
      title: row.title,
      interpretation: row.interpretation,
      cards,
      spreadId: row.spreadId,
      createdAt: Number(row.created_at) * 1000,
    };

    console.log('Lectura devuelta:', result);

    console.groupEnd();
    return c.json(result);
  } catch (err) {
    console.error('💥 /readings/:id ERROR:', err);
    console.groupEnd();
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// CDN PROXY — /cdn/*
// ============================================================
app.get('/cdn/*', async (c) => {
  console.groupCollapsed(
    '%c🖼 /cdn/*',
    'color:#90caf9;font-weight:bold;'
  );

  const key = c.req.path.replace(/^\/cdn\//, '');
  const url = `${CDN_BASE}/${encodeURI(key)}`;

  console.log('Solicitado:', key);
  console.log('URL real:', url);

  try {
    const res = await fetch(url, {
      cf: {
        cacheTtl: 60 * 60 * 24 * 30,
        cacheEverything: true,
      },
    });

    if (!res.ok) {
      console.warn('❌ CDN 404/ERR:', res.status);
      console.groupEnd();
      return c.text('not found', 404);
    }

    console.log('✓ CDN OK');

    console.groupEnd();
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('💥 CDN ERROR:', err);
    console.groupEnd();
    return c.text('cdn error', 502);
  }
});

// ============================================================
// EXPORT DEFAULT
// ============================================================
console.log(
  '%c🚀 Worker inicializado correctamente',
  'color:#00e676;font-weight:bold; font-size:16px;'
);

export default app;
