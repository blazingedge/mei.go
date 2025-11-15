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
  'https://pub-dd5dcc9095b64f479cded9e2d85818d9.r2.dev/assets/v1'; // R2 pÃºblico

type Bindings = {
  DB: D1Database;
  HF_TOKEN?: string;
  HF2_TOKEN?: string;
  ENV?: string;
  TURNSTILE_SECRET: string;
};
const app = new Hono<{ Bindings: Bindings }>();

type PlanId = 'luz' | 'sabiduria' | 'quantico';
const PLAN_LIMITS: Record<PlanId, { monthly: number }> = {
  luz: { monthly: 2 },
  sabiduria: { monthly: 1000000 },
  quantico: { monthly: Number.MAX_SAFE_INTEGER },
} as const;


function nowYm()
{ const d=new Date(); 
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }


// =====================
// CORS (global) + OPTIONS
// ===========
// =====================
// ðŸ” ENV & UTILS
// =====================




function isDevEnv(req: Request, env: Env) {
  return (
    !env.ENV ||
    env.ENV === 'development' ||
    req.url.includes('127.0.0.1') ||
    req.url.includes('localhost')
  );
}

function getAllowedOrigin(origin: string | null, req: Request, env: Env) {
  if (!origin) return '*';
  const isDev = isDevEnv(req, env);
  const allowed = isDev ? LOCAL_ORIGINS : PROD_ORIGINS;

  // ðŸ”¹ Normaliza equivalentes localhost / 127.0.0.1
  const normalized = origin.replace('127.0.0.1', 'localhost');
  if (allowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized)) {
    return origin; // âœ… devuelve exactamente el origin que pidiÃ³ el browser
  }

  // ðŸ”¹ En producciÃ³n, solo devuelve la coincidencia exacta
  if (!isDev && allowed.includes(origin)) return origin;

  // ðŸ”¹ Fallback seguro (primero vÃ¡lido o '*')
  return allowed[0] ?? '*';
}

// âœ… helper: asegurar plan del usuario
async function ensureUserPlan(env: Env, uid: string): Promise<PlanId> {
  const row = await env.DB.prepare('SELECT plan FROM users WHERE uid=?').bind(uid).first<{ plan: string }>();
  if (row?.plan) return row.plan as any;

  await env.DB.prepare(
    'INSERT OR REPLACE INTO users(uid, email, plan, created_at, updated_at) VALUES(?,?,?,?,?)'
  ).bind(uid, null, 'luz', Date.now(), Date.now()).run();

  return 'luz';
}

// âœ… helper: asegurar fila de cuota del mes
async function ensureQuotaRow(env: Env, uid: string, plan: PlanId, period: string) {
  const row = await env.DB.prepare('SELECT monthly_limit, used FROM quotas WHERE uid=? AND period=?')
    .bind(uid, period)
    .first<{ monthly_limit: number; used: number }>();

  if (row) return { monthly: row.monthly_limit, used: row.used };

  const monthly = PLAN_LIMITS[plan].monthly;
  await env.DB.prepare(
    'INSERT INTO quotas(uid, plan, period, monthly_limit, used, updated_at) VALUES(?,?,?,?,?,?)'
  ).bind(uid, plan, period, monthly, 0, Date.now()).run();

  return { monthly, used: 0 };
}

function getNextResetDate(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

async function getUserQuotaState(env: Env, uid: string) {
  const plan = await ensureUserPlan(env, uid);
  const period = nowYm();
  const { monthly, used } = await ensureQuotaRow(env, uid, plan, period);
  const remaining = Math.max(monthly - used, 0);
  return { plan, monthly, used, remaining, nextResetDate: getNextResetDate() };
}

async function checkAndConsumeQuota(env: Env, uid: string): Promise<boolean> {
  if (uid === 'guest') return true;
  const period = nowYm();
  const plan = await ensureUserPlan(env, uid);
  const { monthly, used } = await ensureQuotaRow(env, uid, plan, period);
  if (monthly - used <= 0) return false;

  await env.DB.prepare(
    'UPDATE quotas SET used = used + 1, updated_at=? WHERE uid=? AND period=?'
  ).bind(Date.now(), uid, period).run();

  return true;
}

async function addQuotaCredits(env: Env, uid: string, amount: number) {
  if (amount <= 0 || uid === 'guest') return;
  const plan = await ensureUserPlan(env, uid);
  const period = nowYm();
  await ensureQuotaRow(env, uid, plan, period);
  await env.DB.prepare(
    'UPDATE quotas SET used = MAX(used - ?, 0), updated_at=? WHERE uid=? AND period=?'
  ).bind(amount, Date.now(), uid, period).run();
}

async function setUserPlan(env: Env, uid: string, plan: PlanId) {
  await ensureUserPlan(env, uid);
  await env.DB.prepare(
    'UPDATE users SET plan = ?, updated_at=? WHERE uid=?'
  ).bind(plan, Date.now(), uid).run();
}

async function resetQuotaForPlan(env: Env, uid: string, plan: PlanId) {
  const period = nowYm();
  await ensureQuotaRow(env, uid, plan, period);
  await env.DB.prepare(
    'UPDATE quotas SET monthly_limit = ?, used = 0, updated_at=? WHERE uid=? AND period=?'
  ).bind(PLAN_LIMITS[plan].monthly, Date.now(), uid, period).run();
}

type ReadingBlockReason = 'quota' | 'drucoins';
async function canDoReading(
  env: Env,
  uid: string,
  opts?: { isMaster?: boolean }
): Promise<{ allowed: boolean; reason?: ReadingBlockReason }> {
  if (opts?.isMaster) return { allowed: true };
  if (!uid || uid === 'guest') return { allowed: true };

  const quota = await getUserQuotaState(env, uid);
  if (quota.remaining <= 0) return { allowed: false, reason: 'quota' };

  const balance = await getDrucoinBalance(env, uid);
  if (balance <= 0) return { allowed: false, reason: 'drucoins' };

  return { allowed: true };
}

let drucoinTableReady = false;
async function ensureDrucoinTable(env: Env) {
  if (drucoinTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS drucoins (
      uid TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )
  `).run();
  drucoinTableReady = true;
}

async function ensureDrucoinWallet(env: Env, uid: string) {
  await ensureDrucoinTable(env);
  await env.DB.prepare('INSERT OR IGNORE INTO drucoins(uid, balance, updated_at) VALUES(?,?,?)')
    .bind(uid, 0, Date.now())
    .run();
}

async function getDrucoinBalance(env: Env, uid: string): Promise<number> {
  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare('SELECT balance FROM drucoins WHERE uid=?').bind(uid).first<{ balance: number }>();
  return row?.balance ?? 0;
}

async function addDrucoins(env: Env, uid: string, amount: number): Promise<number> {
  if (amount <= 0) return getDrucoinBalance(env, uid);
  await ensureDrucoinWallet(env, uid);
  await env.DB.prepare('UPDATE drucoins SET balance = balance + ?, updated_at=? WHERE uid=?')
    .bind(amount, Date.now(), uid)
    .run();
  return getDrucoinBalance(env, uid);
}

async function useDrucoins(env: Env, uid: string, amount = 1): Promise<boolean> {
  if (amount <= 0) return true;
  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare('SELECT balance FROM drucoins WHERE uid=?').bind(uid).first<{ balance: number }>();
  const balance = row?.balance ?? 0;
  if (balance < amount) return false;

  await env.DB.prepare('UPDATE drucoins SET balance = balance - ?, updated_at=? WHERE uid=?')
    .bind(amount, Date.now(), uid)
    .run();
  return true;
}

async function hasAcceptedTerms(env: Env, uid: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM terms_acceptance WHERE uid = ? LIMIT 1'
  ).bind(uid).first();
  return !!row;
}

app.get('/api/quota', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;
    const quota = await getUserQuotaState(c.env, uid);

    return c.json({ ok: true, quota });
  } catch (err: any) {
    console.error('ðŸ’¥ /api/quota error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

app.post('/api/subscriptions/check', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const quota = await getUserQuotaState(c.env, uid);
    const drucoins = await getDrucoinBalance(c.env, uid);

    return c.json({
      ok: true,
      plan: quota.plan,
      isLuz: quota.plan === 'luz',
      isSabiduria: quota.plan === 'sabiduria',
      isQuantico: quota.plan === 'quantico',
      hasDonations: drucoins > 0,
      drucoins,
      quota,
    });
  } catch (err: any) {
    console.error('💥 /api/subscriptions/check error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});


app.post('/api/subscriptions/sabiduria/activate', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    await setUserPlan(c.env, uid, 'sabiduria');
    await resetQuotaForPlan(c.env, uid, 'sabiduria');
    const balance = await addDrucoins(c.env, uid, 30);

    return c.json({ ok: true, plan: 'sabiduria', balance });
  } catch (err: any) {
    console.error('💥 /api/subscriptions/sabiduria error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.post('/api/subscriptions/premium/activate', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    await setUserPlan(c.env, uid, 'quantico');
    await resetQuotaForPlan(c.env, uid, 'quantico');
    const balance = await addDrucoins(c.env, uid, 60);

    return c.json({
      ok: true,
      message: 'Pronto daremos más información en nuestro vlog.',
      plan: 'quantico',
      balance,
    });
  } catch (err: any) {
    console.error('💥 /api/subscriptions/premium error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.use('*', cors({
  origin: (origin, c) => {
    const env = c.env as any;
    const isDev = !env.ENV || env.ENV === 'development';

    // âœ” En desarrollo permite localhost
    if (isDev) {
      const localAllowed = ['http://localhost:4200', 'http://127.0.0.1:4200'];
      if (!origin) return localAllowed[0];

      const normalized = origin.replace('127.0.0.1', 'localhost');
      const ok = localAllowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized);
      return ok ? origin : localAllowed[0];
    }

    // âœ” En producciÃ³n permitir:
    //    - dominio principal
    //    - cualquier preview *.mei-go.pages.dev
    if (!origin) return 'https://mei-go.pages.dev';

    if (origin === 'https://mei-go.pages.dev') return origin;

    if (origin.endsWith('.mei-go.pages.dev')) return origin;

    // âŒ cualquier otro â†’ bloquear
    return 'https://mei-go.pages.dev';
  },

  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400,
}));

app.get('/api/session/validate', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, reason: 'invalid_token' }, 401);

    try {
      const apiKey = c.env.FIREBASE_API_KEY || '';
      const verified = await verifyFirebaseIdToken(token, apiKey);
      const uid = verified.uid;
      const email = verified.email;

      const quota = await getUserQuotaState(c.env, uid);
      const balance = await getDrucoinBalance(c.env, uid);
      const needsTerms = !(await hasAcceptedTerms(c.env, uid));

      return c.json({
        ok: true,
        user: {
          uid,
          email,
          plan: quota.plan,
        },
        quota: {
          monthly: quota.monthly,
          used: quota.used,
          remaining: quota.remaining,
          period: nowYm(),
        },
        drucoins: balance,
        needsTerms,
      });
    } catch {
      return c.json({ ok: false, reason: 'invalid_token' }, 401);
    }
  } catch (err: any) {
    console.error('💥 /api/session/validate error:', err);
    return c.json({ ok: false, reason: 'internal_error' }, 500);
  }
});

app.post('/api/drucoins/add', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 0 } = await c.req.json<{ amount?: number }>().catch(() => ({ amount: 0 }));
    if (!amount || amount <= 0) {
      return c.json({ ok: false, error: 'invalid_amount' }, 400);
    }

    const donationCoins = 2;
    await addQuotaCredits(c.env, uid, 2);
    const balance = await addDrucoins(c.env, uid, donationCoins);
    return c.json({ ok: true, balance, granted: donationCoins });
  } catch (err: any) {
    console.error('💥 /api/drucoins/add error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});


app.post('/api/drucoins/purchase', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 0 } = await c.req.json<{ amount?: number }>().catch(() => ({ amount: 0 }));
    const packs: Record<number, number> = { 1: 2, 2: 5, 5: 15 };
    const granted = packs[amount] ?? 0;
    if (!granted) {
      return c.json({ ok: false, error: 'invalid_amount' }, 400);
    }

    const balance = await addDrucoins(c.env, uid, granted);
    return c.json({ ok: true, balance, granted });
  } catch (err: any) {
    console.error('💥 /api/drucoins/purchase error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.post('/api/drucoins/use', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { amount = 1 } = await c.req.json<{ amount?: number }>().catch(() => ({ amount: 1 }));
    const okUse = await useDrucoins(c.env, uid, amount || 1);
    if (!okUse) {
      return c.json({ ok: false, error: 'sin_drucoins', message: 'Sin drucoins suficientes.' }, 402);
    }
    const balance = await getDrucoinBalance(c.env, uid);
    return c.json({ ok: true, balance });
  } catch (err: any) {
    console.error('💥 /api/drucoins/use error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});

app.get('/api/drucoins/balance', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const balance = await getDrucoinBalance(c.env, uid);
    return c.json({ ok: true, balance });
  } catch (err: any) {
    console.error('💥 /api/drucoins/balance error:', err);
    return c.json({ ok: false, error: err?.message || 'internal_error' }, 500);
  }
});





// =====================
// Roles de usuario
// =====================
const MASTER_USER = 'laife91@gmail.com';

function isMasterUser(email?: string): boolean {
  return email?.toLowerCase() === MASTER_USER;
}



// =====================
// Debug / Auth demo (D1)
// =====================
app.get('/debug/version', (c) => c.json({ v: 'tarot@1' }));

app.post('/auth/register', async (c) => {
  try {
    const { email, password } = await c.req.json<{ email?: string; password?: string }>();
    if (!email || !password) return c.json({ ok: false, error: 'missing_fields' }, 400);

    const hash = await bcrypt.hash(password, 10);
    await c.env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .bind(email, hash)
      .run();

    return c.json({ ok: true });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const isUnique = /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
    return c.json({ ok: false, error: isUnique ? 'email_taken' : msg }, isUnique ? 409 : 500);
  }
});

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!email || !password) return c.json({ ok: false, error: 'missing_fields' }, 400);

  const row = await c.env.DB
    .prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; password_hash: string }>();

  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return c.json({ ok: false, error: 'invalid_credentials' }, 401);

  return c.json({ ok: true, token: 'fake-token', user: { id: row.id, email: row.email } });
});

app.post('/captcha/verify', async (c) => {
  try {
    const { token } = await c.req.json<{ token: string }>();
    if (!token) {
      return c.json({ ok: false, error: 'missing token' }, 400);
    }

    const form = new FormData();
    form.append('secret', c.env.TURNSTILE_SECRET);
    form.append('response', token);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });

    const data = await resp.json<any>();
    if (!data.success) {
      console.warn('âš ï¸ Turnstile fallÃ³:', data['error-codes']);
      return c.json({ ok: false }, 400);
    }

    return c.json({ ok: true });
  } catch (err: any) {
    console.error('ðŸ’¥ Error verificando captcha:', err);
    return c.json({ ok: false, error: err.message || 'internal error' }, 500);
  }
});
// =====================
// Tarot
// =====================
type Suit = 'wands' | 'swords' | 'cups' | 'pents' | 'major';
type CardMeta = {
  id: string;       // p.ej. "wands-01"
  suit: Suit;       // 'wands'|'swords'|...
  name: string;     // "As de Bastos"
  keywords: string[];
  meaningUp: string;
  meaningRev: string;
  imageUrl: string; // **SIEMPRE** /cdn/... (luego se absolutiza)
};

const RANK_NAME: Record<number, string> = {
  1: 'As', 2: 'Dos', 3: 'Tres', 4: 'Cuatro', 5: 'Cinco',
  6: 'Seis', 7: 'Siete', 8: 'Ocho', 9: 'Nueve', 10: 'Diez',
  11: 'Sota', 12: 'Caballero', 13: 'Reina', 14: 'Rey',
};

const SUIT_ES: Record<Suit, string> = {
  wands: 'Bastos', swords: 'Espadas', cups: 'Copas', pents: 'Oros', major: 'Arcanos',
};

// === Nombres de archivos EXACTOS (R2) ===
// === Archivos por palo ===

// ðŸ”¥ Bastos
const FILES_WANDS = [
  'asdebastos.webp','dosdebastos.webp','tresdebastos.webp','cuatrodebastos.webp',
  'cincodebastos.webp','seisdebastos.webp','sietedebastos.webp','ochodebastos.webp',
  'nuevedebastos.webp','diezdebastos.webp','pagedebastos.webp',
  'caballerodebastos.webp','reinadebastos.webp','reydebastos.webp',
] as const;

// âš”ï¸ Espadas
const FILES_SWORDS = [
  'asdeespadas.webp','dosdeespadas.webp','tresdeespadas.webp','cuatrodeespadas.webp',
  'cincodeespadas.webp','seisdeespadas.webp','sietedeespadas.webp','ochodeespadas.webp',
  'nuevedeespadas.webp','diezdeespadas.webp','pagedeespadas.webp',
  'caballerodeespadas.webp','reinadeespadas.webp','reydeespadas.webp',
] as const;

// ðŸ’§ Copas
const FILES_CUPS = [
  'asdecopas.webp','dosdecopas.webp','tresdecopas.webp','cuatrodecopas.webp',
  'cincodecopas.webp','seisdecopas.webp','sietedecopas.webp','ochodecopas.webp',
  'nuevedecopas.webp','diezdecopas.webp','pagedecopas.webp',
  'caballerodecopas.webp','reinadecopas.webp','reydecopas.webp',
] as const;

// ðŸª™ PentÃ¡culos
const FILES_PENTS = [
  'asdepentaculos.webp','dosdepentaculos.webp','tresdepentaculos.webp','cuatrodepentaculos.webp',
  'cincodepentaculos.webp','seisdepentaculos.webp','sietedepentaculos.webp','ochodepentaculos.webp',
  'nuevedepentaculos.webp','diezdepentaculos.webp','pagedepentaculos.webp',
  'caballerodepentaculos.webp','reinadepentaculos.webp','reydepentaculos.webp',
] as const;

// ðŸŒŸ Arcanos Mayores
const FILES_MAJOR = [
  'elloco.webp','elmago.webp','lagransacerdotisa.webp','laemperatriz.webp','elemperador.webp',
  'elpapa.webp','losenamorados.webp','elcarro.webp','lafuerza.webp','elermitano.webp',
  'ruedadelafortuna.webp','lajusticia.webp','elcolgado.webp','lamuerte.webp','latemplanza.webp',
  'eldiablo.webp','latorre.webp','laestrella.webp','laluna.webp','elsol.webp','eljuicio.webp','elmundo.webp',
] as const;

// === ConstrucciÃ³n del mazo completo ===
function buildDeckFromFiles(): CardMeta[] {
  const out: CardMeta[] = [];
  const sets: [readonly string[], Suit][] = [
    [FILES_WANDS, 'wands'],
    [FILES_SWORDS, 'swords'],
    [FILES_CUPS, 'cups'],
    [FILES_PENTS, 'pents'],
    [FILES_MAJOR, 'major'],
  ];

  for (const [files, suit] of sets) {
    for (const f of files) {
      const m = fileToCardMeta(f, suit);
      if (m) out.push(m);
    }
  }

  out.sort((a, b) =>
    a.suit === b.suit
      ? Number(a.id.slice(-2)) - Number(b.id.slice(-2))
      : a.suit.localeCompare(b.suit)
  );
  return out;
}



const cardNamesEs: Record<string, string> = {
  // Bastos
  'wands-01': 'As de Bastos',
  'wands-02': 'Dos de Bastos',
  'wands-03': 'Tres de Bastos',
  'wands-04': 'Cuatro de Bastos',
  'wands-05': 'Cinco de Bastos',
  'wands-06': 'Seis de Bastos',
  'wands-07': 'Siete de Bastos',
  'wands-08': 'Ocho de Bastos',
  'wands-09': 'Nueve de Bastos',
  'wands-10': 'Diez de Bastos',
  'wands-11': 'Sota de Bastos',
  'wands-12': 'Caballero de Bastos',
  'wands-13': 'Reina de Bastos',
  'wands-14': 'Rey de Bastos',

  // Copas
  'cups-01': 'As de Copas',
  'cups-02': 'Dos de Copas',
  'cups-03': 'Tres de Copas',
  'cups-04': 'Cuatro de Copas',
  'cups-05': 'Cinco de Copas',
  'cups-06': 'Seis de Copas',
  'cups-07': 'Siete de Copas',
  'cups-08': 'Ocho de Copas',
  'cups-09': 'Nueve de Copas',
  'cups-10': 'Diez de Copas',
  'cups-11': 'Sota de Copas',
  'cups-12': 'Caballero de Copas',
  'cups-13': 'Reina de Copas',
  'cups-14': 'Rey de Copas',

  // Espadas
  'swords-01': 'As de Espadas',
  'swords-02': 'Dos de Espadas',
  'swords-03': 'Tres de Espadas',
  'swords-04': 'Cuatro de Espadas',
  'swords-05': 'Cinco de Espadas',
  'swords-06': 'Seis de Espadas',
  'swords-07': 'Siete de Espadas',
  'swords-08': 'Ocho de Espadas',
  'swords-09': 'Nueve de Espadas',
  'swords-10': 'Diez de Espadas',
  'swords-11': 'Sota de Espadas',
  'swords-12': 'Caballero de Espadas',
  'swords-13': 'Reina de Espadas',
  'swords-14': 'Rey de Espadas',

  // PentÃ¡culos
  'pentacles-01': 'As de PentÃ¡culos',
  'pentacles-02': 'Dos de PentÃ¡culos',
  'pentacles-03': 'Tres de PentÃ¡culos',
  'pentacles-04': 'Cuatro de PentÃ¡culos',
  'pentacles-05': 'Cinco de PentÃ¡culos',
  'pentacles-06': 'Seis de PentÃ¡culos',
  'pentacles-07': 'Siete de PentÃ¡culos',
  'pentacles-08': 'Ocho de PentÃ¡culos',
  'pentacles-09': 'Nueve de PentÃ¡culos',
  'pentacles-10': 'Diez de PentÃ¡culos',
  'pentacles-11': 'Sota de PentÃ¡culos',
  'pentacles-12': 'Caballero de PentÃ¡culos',
  'pentacles-13': 'Reina de PentÃ¡culos',
  'pentacles-14': 'Rey de PentÃ¡culos',

  // Arcanos mayores
  'major-00': 'El Loco',
  'major-01': 'El Mago',
  'major-02': 'La Sacerdotisa',
  'major-03': 'La Emperatriz',
  'major-04': 'El Emperador',
  'major-05': 'El Hierofante',
  'major-06': 'Los Enamorados',
  'major-07': 'El Carro',
  'major-08': 'La Fuerza',
  'major-09': 'El ErmitaÃ±o',
  'major-10': 'La Rueda de la Fortuna',
  'major-11': 'La Justicia',
  'major-12': 'El Colgado',
  'major-13': 'La Muerte',
  'major-14': 'La Templanza',
  'major-15': 'El Diablo',
  'major-16': 'La Torre',
  'major-17': 'La Estrella',
  'major-18': 'La Luna',
  'major-19': 'El Sol',
  'major-20': 'El Juicio',
  'major-21': 'El Mundo'
};

// === Parse helpers ===
function stripAccentsLower(s: string) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// util simple para verificar Firebase ID token (sin librerÃ­as pesadas)
async function verifyFirebaseIdToken(idToken: string, apiKey: string) {
  const resp = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!resp.ok) throw new Error('invalid_token');

  const data = await resp.json();
  const user = data?.users?.[0];
  if (!user) throw new Error('invalid_token');

  return {
    uid: user.localId,
    email: (user.email || '').toLowerCase(),
  };
}



const RANK_FROM_WORD: Record<string, number> = {
  as: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  sota: 11, page: 11, paged: 11, pagede: 11,
  caballero: 12, knight: 12,
  reina: 13, queen: 13,
  rey: 14, king: 14,
};

function parseMetaFromFilename(file: string): { rank?: number; suit?: Suit } {
  const base = stripAccentsLower(file.replace(/\.[a-z0-9]+$/i, ''));
  const tokens = base.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

  let suit: Suit | undefined;

  if (tokens.some(t => t.includes('bastos'))) suit = 'wands';
  else if (tokens.some(t => t.includes('espadas'))) suit = 'swords';
  else if (tokens.some(t => t.includes('copas'))) suit = 'cups';
  else if (tokens.some(t => t.includes('pentaculo') || t.includes('oro'))) suit = 'pents';
  else if (
    tokens.some(t =>
      [
        // ðŸœ‚ Todos los Arcanos Mayores
        'loco', 'mago', 'sacerdotisa', 'emperatriz', 'emperador',
        'pap', 'hierofante', 'enamorados', 'carro', 'fuerza',
        'ermitano', 'rueda', 'justicia', 'colgado', 'muerte',
        'templanz', 'diablo', 'torre', 'estrella', 'luna',
        'sol', 'juicio', 'mundo'
      ].some(k => t.includes(k))
    )
  ) suit = 'major';

  let rank: number | undefined;
  for (const t of tokens) {
    if (RANK_FROM_WORD[t] != null) {
      rank = RANK_FROM_WORD[t];
      break;
    }
  }

  if (!rank) {
    const start = tokens[0] ?? '';
    if (start.startsWith('as')) rank = 1;
    else if (start.startsWith('dos')) rank = 2;
    else if (start.startsWith('tres')) rank = 3;
    else if (start.startsWith('cuatro')) rank = 4;
    else if (start.startsWith('cinco')) rank = 5;
    else if (start.startsWith('seis')) rank = 6;
    else if (start.startsWith('siete')) rank = 7;
    else if (start.startsWith('ocho')) rank = 8;
    else if (start.startsWith('nueve')) rank = 9;
    else if (start.startsWith('diez')) rank = 10;
    else if (start.startsWith('sota') || start.startsWith('page')) rank = 11;
    else if (start.startsWith('caballero')) rank = 12;
    else if (start.startsWith('reina')) rank = 13;
    else if (start.startsWith('rey')) rank = 14;
  }

  return { rank, suit };
}


function rankNameEs(rank: number): string {
  return RANK_NAME[rank] ?? String(rank);
}
function suitEs(suit: Suit): string {
  return SUIT_ES[suit];
}


function fileToCardMeta(file: string, forcedSuit?: Suit): CardMeta | null {
  const parsed = parseMetaFromFilename(file);
  const suit = forcedSuit ?? parsed.suit;
  let rank = parsed.rank;

  // ðŸª¶ Forzar rank en arcanos mayores segÃºn su posiciÃ³n en FILES_MAJOR
  if (suit === 'major') {
    const index = FILES_MAJOR.indexOf(file);
    if (index >= 0) rank = index; // 0..21
  }

  if (!suit || rank == null) return null;

  const id = `${suit}-${String(rank).padStart(2, '0')}`;
  const name =
    suit === 'major'
      ? cardNamesEs[id] || file.replace(/\.webp$/, '')
      : `${rankNameEs(rank)} de ${suitEs(suit)}`;

  return {
    id,
    suit,
    name,
    keywords: [],
    meaningUp: '',
    meaningRev: '',
    imageUrl: `/cdn/cards/${file}`,
  };
}





const FULL_DECK = buildDeckFromFiles();

// =====================
// Spreads
// =====================
app.get('/api/spreads', (c) =>
  c.json([
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
      name: 'Pasado Â· Presente Â· Futuro',
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
  ])
);


// =====================
// Deck (front)
// =====================
app.get('/api/decks', (c) => {
  const origin = new URL(c.req.url).origin; // p.ej. http://127.0.0.1:8787
  const deckAbs = FULL_DECK.map(m => ({
    ...m,
    imageUrl: new URL(m.imageUrl, origin).toString(), // absolutiza al mismo origen
  }));
  return c.json(deckAbs);
});

// =====================
// Draw
// =====================
const hashSeed = (s: string) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const rng32 = (a: number) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function shuffle<T>(arr: T[], rnd: () => number) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}


// =====================
// /api/draw â€” Genera una tirada de cartas
// =====================
app.post('/api/draw', async (c) => {
  try {
    // ==============================
    // ðŸ” AutenticaciÃ³n Firebase
    // ==============================
    let uid = 'guest';
    let email = 'guest';
    let isMaster = false;

    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
        email = verified.email;
        isMaster = isMasterUser(email);
      } catch (err) {
        console.warn('âš ï¸ Token Firebase invÃ¡lido:', err);
      }
    }

    // ==============================
    // ðŸ§­ Cuerpo del request
    // ==============================
    const body = (await c.req.json().catch(() => ({}))) as {
      spreadId?: string;
      seed?: string;
      allowsReversed?: boolean;
      context?: string;
    };

    const spreadId = body.spreadId ?? 'celtic-cross-10';
    const allowsReversed = body.allowsReversed ?? true;
    const seed = body.seed ?? Date.now().toString();
    const today = new Date().toISOString().slice(0, 10);

    // ==============================
    // âš™ï¸ Detectar modo y rol
    // ==============================
    const isDev =
      !c.env.ENV ||
      c.env.ENV === 'development' ||
      c.req.url.includes('127.0.0.1') ||
      c.req.url.includes('localhost');

    if (isDev) console.log('ðŸ§  [DRAW] Modo desarrollo detectado.');
    if (isMaster) console.log('ðŸŒŸ [DRAW] MasterUser detectado (sin lÃ­mites).');

    // ==============================
    // ðŸ“… Control de lÃ­mite diario
    // ==============================
    // ==============================
// ðŸ“… Control de lÃ­mite mensual por plan
// ==============================
let remaining = '∞';



if (!isMaster && uid !== 'guest' && c.env.DB) {

  const readingGate = await canDoReading(c.env, uid, { isMaster });

  if (!readingGate.allowed) {

    return c.json({ ok: false, reason: readingGate.reason }, 402);

  }



  const allowed = await checkAndConsumeQuota(c.env, uid);

  if (!allowed) {

    return c.json({ ok: false, reason: 'quota' }, 402);

  }



  const quotaState = await getUserQuotaState(c.env, uid);

  remaining = String(quotaState.remaining);

}





    



// ==============================
    // ðŸ”® Generar tirada
    // ==============================
    const count =
      spreadId === 'ppf-3' ? 3 :
      spreadId === 'free'  ? 9 : 10;

    const hashSeed = (s: string) =>
      [...s].reduce((h, ch) => Math.imul(31, h) + ch.charCodeAt(0) | 0, 0);

    function makeRNG(seed: number) {
      let x = seed | 0;
      return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return ((x >>> 0) % 10000) / 10000;
      };
    }

    const seedNum = hashSeed(seed);
    const rnd = makeRNG(seedNum);
    const reverseChance = 0.4;

    const ids = FULL_DECK.map((d) => d.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const selected = ids.slice(0, count);

    const cards = selected.map((id, i) => ({
      position: i + 1,
      cardId: id,
      reversed: allowsReversed ? rnd() < reverseChance : false,
    }));

    console.log(`[DRAW] Tirada (${email}) â†’`, cards.map(c => `${c.cardId}${c.reversed ? 'â†“' : 'â†‘'}`).join(', '));

    // ==============================
    // ðŸ’¾ Guardar tirada (solo usuarios reales)
    // ==============================
    try {
      if (c.env.DB && uid !== 'guest') {
        await c.env.DB.prepare(`
          INSERT INTO draws (uid, email, day, spreadId, context, cards_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(uid, email, today, spreadId, body.context || '', JSON.stringify(cards))
        .run();
      }
    } catch (saveErr) {
      console.warn('âš ï¸ [DRAW] No se pudo guardar la tirada:', saveErr);
    }

    // ==============================
    // âœ… Respuesta final
    // ==============================
    return c.json({
      ok: true,
      spreadId,
      seed,
      uid,
      email,
      cards,
      remaining,
    });

  } catch (err: any) {
    console.error('ðŸ’¥ [DRAW] Error interno:', err);
    return c.json({ ok: false, error: 'internal_error', message: String(err?.message ?? err) }, 500);
  }
});






// =====================
// ðŸ”® /api/card-meaning â€” Significado de carta individual (Hugging Face nuevo router)
// =====================
app.post('/api/card-meaning', async (c) => {
  try {
    const { name, reversed } = await c.req.json<{ name: string; reversed?: boolean }>();
    const token = c.env.HF_TOKEN;
    if (!token)
      return c.json({ ok: false, message: 'No se encontrÃ³ el token HF_TOKEN' }, 401);

    const prompt = `
Eres un intÃ©rprete experto en tarot celta.
Explica el significado simbÃ³lico de la carta **${name}**${reversed ? ' (invertida)' : ''}.
Usa un tono reflexivo y espiritual, sin emojis ni autopromociÃ³n.
Responde en formato **Markdown** con 2 o 3 pÃ¡rrafos cortos.
`;

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
          max_tokens: 500,
          temperature: 0.7,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('âŒ Error HF:', response.status, text);
      return c.json({ ok: false, message: `Error HF ${response.status}: ${text}` });
    }

    const result = await response.json();
    let meaning = result?.choices?.[0]?.text?.trim() || '';

    meaning = meaning
      .replace(/(Â¡?Gracias[^]+$)/i, '')
      .replace(/(SÃ­gueme[^]+$)/i, '')
      .replace(/\*{3,}/g, '**');

    return c.json({ ok: true, meaning });
  } catch (err: any) {
    console.error('ðŸ’¥ [CARD-MEANING] Error interno:', err);
    return c.json({ ok: false, message: err?.message || String(err) }, 500);
  }
});







// =====================
// Historial remoto
// =====================

app.post('/api/history/save', async (c) => {
  try {
    const { id, spreadId, spreadLabel, cards, ts } = await c.req.json();
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let uid = 'guest';
    let email = 'guest';

    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
        email = verified.email;
      } catch {
        return c.json({ ok: false, error: 'invalid_token' }, 401);
      }
    }

    if (uid === 'guest') return c.json({ ok: false, error: 'unauthorized' }, 401);

    await c.env.DB.prepare(`
      INSERT INTO history (id, uid, spreadId, spreadLabel, cards_json, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, uid, spreadId, spreadLabel, JSON.stringify(cards), ts ?? Date.now()).run();

    return c.json({ ok: true });
  } catch (err) {
    console.error('ðŸ’¥ /api/history/save error:', err);
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

app.get('/api/history/list', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let uid = 'guest';
    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
      } catch {
        return c.json({ ok: false, error: 'invalid_token' }, 401);
      }
    }

    const rows = await c.env.DB.prepare(
      'SELECT id, spreadId, spreadLabel, cards_json, ts FROM history WHERE uid = ? ORDER BY ts DESC LIMIT 50'
    ).bind(uid).all();

    const list = rows.results?.map(r => ({
      id: r.id,
      spreadId: r.spreadId,
      spreadLabel: r.spreadLabel,
      cards: JSON.parse(r.cards_json || '[]'),
      ts: Number(r.ts)
    })) ?? [];

    return c.json({ ok: true, history: list });
  } catch (err) {
    console.error('ðŸ’¥ /api/history/list error:', err);
    return c.json({ ok: false, message: String(err) }, 500);
  }
});







// Proxy CDN: /cdn/* â†’ R2 (maneja mayÃºsculas y minÃºsculas)
const R2_BASE = `${CDN_BASE}`;

// âœ… Deja una sola definiciÃ³n de /cdn/*
// y NO fuerces a minÃºsculas; ademÃ¡s, reintenta con capitalizaciÃ³n si 404

// âœ… CDN proxy limpio (sin reintentos ni mayÃºsculas)
app.get('/cdn/*', async (c) => {
  const key = c.req.path.replace(/^\/cdn\//, ''); // ruta relativa dentro del bucket
  const url = `${CDN_BASE}/${encodeURI(key)}`;

  try {
    const res = await fetch(url, {
      cf: {
        cacheTtl: 60 * 60 * 24 * 30, // 30 dÃ­as
        cacheEverything: true,
      },
    });

    if (!res.ok) {
      console.warn('âš ï¸ [CDN Proxy] 404 o error para', url);
      return c.text('not found', 404, {
        'Access-Control-Allow-Origin': '*',
      });
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cross-Origin-Embedder-Policy': 'unsafe-none',
        'Cross-Origin-Opener-Policy': 'unsafe-none',
      },
    });
  } catch (err) {
    console.error('ðŸ’¥ [CDN Proxy] Error al obtener', url, err);
    return c.text('cdn error', 502, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }
});

// =====================
// ðŸ’¾ /api/readings/save â€” Guarda interpretaciones generadas por IA
// =====================
app.post('/api/readings/save', async (c) => {
  try {
    const { title, interpretation, cards, spreadId } = await c.req.json<{
      title: string;
      interpretation: string;
      cards: any[];
      spreadId?: string;
    }>();

    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let uid = 'guest';
    let email = 'guest';

    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
        email = verified.email;
      } catch {
        return c.json({ ok: false, error: 'invalid_token' }, 401);
      }
    }

    if (uid === 'guest') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    // ðŸ”¢ LÃ­mite de lecturas guardadas (mÃ¡x 5)
    const countRow = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM readings WHERE uid = ?'
    ).bind(uid).first<{ count: number }>();

    if (countRow && countRow.count >= 5) {
      return c.text('Has alcanzado el mÃ¡ximo (5). Pasa a SabidurÃ­a o dona.', 402);
    }

    // ðŸ’¾ Guarda la lectura
    const id = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO readings (id, uid, email, title, interpretation, cards_json, spreadId, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
      .bind(id, uid, email, title, interpretation, JSON.stringify(cards), spreadId || '')
      .run();

    return c.json({ ok: true, id });
  } catch (err: any) {
    console.error('ðŸ’¥ /api/readings/save error:', err);
    return c.json({ ok: false, message: err.message || String(err) }, 500);
  }
});



// =====================
// ðŸŒ™ /api/interpret â€” InterpretaciÃ³n completa de tirada (Hugging Face nuevo router)
// =====================
app.post('/api/interpret', async (c) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const { context, cards, spreadId } = await c.req.json<{
      context: string;
      cards: { name: string; reversed: boolean }[];
      spreadId?: string;
    }>();

    const authHeader = c.req.header('Authorization') || '';
    const firebaseToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!firebaseToken) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    let uid = '';
    let email = '';
    let isMaster = false;
    try {
      const apiKey = c.env.FIREBASE_API_KEY || '';
      const verified = await verifyFirebaseIdToken(firebaseToken, apiKey);
      uid = verified.uid;
      email = verified.email;
      isMaster = isMasterUser(email);
    } catch (err) {
      console.error('💥 /api/interpret auth error:', err);
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const gate = await canDoReading(c.env, uid, { isMaster });
    if (!gate.allowed) {
      return c.json({ ok: false, reason: gate.reason }, 402);
    }

    if (!isMaster) {
      const okUse = await useDrucoins(c.env, uid);
      if (!okUse) {
        return c.json({ ok: false, reason: 'drucoins' }, 402);
      }
    }

    const token = c.env.HF_TOKEN;
    if (!token)
      return c.json({ ok: false, message: 'No se encontrÃ³ el token HF_TOKEN' }, 401);

    const formattedCards = cards.map((c) => {
      const name = cardNamesEs[c.name] || c.name;
      return `${name}${c.reversed ? ' (invertida)' : ''}`;
    });

    const spreadLabel =
      spreadId === 'celtic-cross-10'
        ? 'Cruz Celta (10 cartas)'
        : spreadId === 'ppf-3'
        ? 'Pasado Â· Presente Â· Futuro'
        : 'Tirada libre';

    // ðŸ’¡ system prompt para guiar tono y formato
    const prompt = `
Eres un guÃ­a espiritual celta que interpreta tiradas de tarot con tono sereno y simbÃ³lico.
Usa **frases cortas y precisas** (mÃ¡x. 2â€“3 lÃ­neas por pÃ¡rrafo).
Evita repeticiones, redundancias o cierres extensos. 
Responde con **3 pÃ¡rrafos mÃ¡ximo**, cada uno claro y distinto.

ðŸ§­ Tipo de tirada: ${spreadLabel}
ðŸ’« Contexto del consultante: "${context || 'Sin contexto'}"

Cartas extraÃ­das:
${formattedCards.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Tu misiÃ³n:
1. Resume el mensaje central.
2. Explica brevemente las energÃ­as o aprendizajes de cada una de las cartas.
3. Cierra con una frase esperanzadora o sabia (una sola oraciÃ³n).

No incluyas saludos, repeticiones ni despedidas.
`;

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
          max_tokens: 700,
          temperature: 0.6,
          top_p: 0.85
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error('âŒ Error HF:', response.status, text);
      return c.json({ ok: false, message: `Error HF ${response.status}: ${text}` });
    }

    const result = await response.json();
    let interpretation = result?.choices?.[0]?.text?.trim() || '';

    // âœ‚ï¸ Post-procesado: elimina firmas o repeticiones
    interpretation = interpretation
      .replace(/(Â¡?Gracias[^]+$)/i, '') // corta despedidas
      .replace(/(\*{2,}.*Licencia.*$)/i, '')
      .replace(/\*{3,}/g, '**')
      .replace(/(_{2,})/g, '')
      .replace(/[\*\_]{2,}\s*$/, '');

    return c.json({ ok: true, interpretation });
  } catch (err: any) {
    console.error('ðŸ’¥ [INTERPRET ERROR]:', err);
    return c.json({ ok: false, message: err?.message || String(err) });
  }
});




// =====================
// ðŸ“œ /api/terms/accept â€” Registrar aceptaciÃ³n de tÃ©rminos
// =====================
app.post('/api/terms/accept', async (c) => {
  try {
    const { version = '1.0', acceptedAt } = await c.req.json<{ version?: string; acceptedAt?: number }>();

    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    // ðŸ” Identificar usuario
    let uid = 'guest';
    if (token) {
      try {
        const apiKey = c.env.FIREBASE_API_KEY || '';
        const verified = await verifyFirebaseIdToken(token, apiKey);
        uid = verified.uid;
      } catch {
        console.warn('âš ï¸ Token invÃ¡lido o expirado, se registra como invitado.');
      }
    }

    // ðŸ” Metadatos
    const ip_address =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For') ||
      c.req.header('X-Real-IP') ||
      'unknown';

    const user_agent = c.req.header('User-Agent') || 'unknown';
    const timestamp = acceptedAt ?? Date.now();

    // ðŸ’¾ Guarda o actualiza aceptaciÃ³n (por UID + versiÃ³n)
    await c.env.DB.prepare(`
      INSERT OR REPLACE INTO terms_acceptance (uid, accepted_at, version, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?)
    `).bind(uid, timestamp, version, ip_address, user_agent).run();

    return c.json({ ok: true, uid, version, accepted_at: timestamp });
  } catch (err: any) {
    console.error('ðŸ’¥ /api/terms/accept error:', err);
    return c.json({ ok: false, message: err.message || 'internal_error' }, 500);
  }
});

// =====================
// ðŸ“˜ /api/terms/check â€” consulta si aceptÃ³ T&C
// =====================
app.post('/api/terms/check', async (c) => {
  try {
    const { uid } = await c.req.json<{ uid: string }>();
    if (!uid) return c.json({ accepted: false });

    const row = await c.env.DB.prepare(
      'SELECT accepted_at FROM terms_acceptance WHERE uid = ?'
    ).bind(uid).first();

    return c.json({ accepted: !!row });
  } catch (err: any) {
    console.error('ðŸ’¥ /api/terms/check error:', err);
    return c.json({ accepted: false });
  }
});

app.get('/api/terms/needs', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ needs: true }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    try {
      const verified = await verifyFirebaseIdToken(token, apiKey);
      const uid = verified.uid;

      const row = await c.env.DB.prepare(
        'SELECT accepted_at FROM terms_acceptance WHERE uid = ?'
      ).bind(uid).first();

      return c.json({ needs: !row });
    } catch {
      return c.json({ needs: true }, 401);
    }
  } catch (err: any) {
    console.error('💥 /api/terms/needs error:', err);
    return c.json({ needs: true }, 500);
  }
});

app.get('/api/readings/list', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const { results } = await c.env.DB.prepare(
      `SELECT id, title, strftime('%s', created_at) as created_at
         FROM readings WHERE uid = ?
         ORDER BY datetime(created_at) DESC`
    ).bind(uid).all();

    const items = (results || []).map(row => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at ? Number(row.created_at) * 1000 : Date.now()
    }));

    return c.json({ ok: true, items });
  } catch (err: any) {
    console.error('💥 /api/readings/list error:', err);
    return c.json({ ok: false, message: err.message || 'internal_error' }, 500);
  }
});

app.get('/api/readings/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const verified = await verifyFirebaseIdToken(token, apiKey);
    const uid = verified.uid;

    const row = await c.env.DB.prepare(
      `SELECT id, title, interpretation, cards_json, spreadId,
              strftime('%s', created_at) as created_at
         FROM readings WHERE id = ? AND uid = ?`
    ).bind(id, uid).first();

    if (!row) {
      return c.json({ ok: false, error: 'not_found' }, 404);
    }

    let cards: any[] = [];
    try {
      cards = row.cards_json ? JSON.parse(row.cards_json) : [];
    } catch {
      cards = [];
    }

    return c.json({
      ok: true,
      id: row.id,
      title: row.title,
      interpretation: row.interpretation,
      cards,
      spreadId: row.spreadId,
      createdAt: row.created_at ? Number(row.created_at) * 1000 : Date.now(),
    });
  } catch (err: any) {
    console.error('💥 /api/readings/:id error:', err);
    return c.json({ ok: false, message: err.message || 'internal_error' }, 500);
  }
});

app.get('/api/reading/check', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return c.json({ ok: false, reason: 'invalid_token' }, 401);

    const apiKey = c.env.FIREBASE_API_KEY || '';
    try {
      const verified = await verifyFirebaseIdToken(token, apiKey);
      const uid = verified.uid;
      const email = verified.email;

      const gate = await canDoReading(c.env, uid, { isMaster: isMasterUser(email) });
      if (gate.allowed) return c.json({ ok: true });

      const reason = gate.reason === 'quota' ? 'no_quota' : 'no_drucoins';
      const message =
        gate.reason === 'quota' ? 'Sin tiradas disponibles' : 'No tienes Drucoins';

      return c.json({ ok: false, reason, message }, 402);
    } catch {
      return c.json({ ok: false, reason: 'invalid_token' }, 401);
    }
  } catch (err: any) {
    console.error('💥 /api/reading/check error:', err);
    return c.json({ ok: false, reason: 'internal_error' }, 500);
  }
});















function getUserRole(email?: string): 'master' | 'freemium' | 'guest' {
  if (!email) return 'guest';
  if (isMasterUser(email)) return 'master';
  return 'freemium';
}


// =====================
// ðŸ”§ Middleware final CORS Fix
// =====================

app.get('/debug/env', (c) => {
  return c.json({
    HF2_TOKEN: c.env.HF2_TOKEN ? 'âœ… cargado' : 'âŒ vacÃ­o',
    HF_TOKEN: c.env.HF_TOKEN ? 'âœ… cargado' : 'âŒ vacÃ­o',
    ENV: c.env.ENV || 'no definido',
  });
});



export default app;






