﻿// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';
import { DECK } from './deck';
import { verifyTurnstile } from './verifyturnstile';
import { APIUserAbortError } from 'openai';


// ============================================================
// 🃏 CARD NAME MAP — Crear mapa ES/EN basado en DECK
// ============================================================
const cardNamesEs: Record<string, string> = {};

for (const card of DECK) {
// card.id = "cups_07"
// card.name = "Siete de Copas"
cardNamesEs[card.id] = card.name;
}

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

RESEND_API_KEY?: string;      // 🔹 para email de bienvenida
RESEND_FROM_EMAIL?: string;   // ej: 'Meigo <no-reply@meigo.app>'

// 🔐 PayPal
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_SECRET?: string;
  PAYPAL_API_BASE?: string; // opcional, por si cambias a sandbox
};


type Env = Bindings;

// Respuesta típica de Firebase Auth (signUp / signInWithPassword)
type FirebaseAuthResponse = {
idToken?: string;
localId?: string;
email?: string;
error?: { message?: string };
};

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
sabiduria: { monthly: 15 },
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

async function sendFirebaseEmailVerification(apiKey: string, idToken: string) {
console.groupCollapsed('%c📧 sendFirebaseEmailVerification', 'color:#ffb300;font-weight:bold;');
try {
const resp = await fetch(
`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`,
{
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
requestType: 'VERIFY_EMAIL',
idToken,
}),
}
);

const data = await resp.json().catch(() => ({}));
console.log('Firebase sendOobCode VERIFY_EMAIL:', resp.status, data);

} catch (err) {
console.error('💥 Error en sendFirebaseEmailVerification:', err);
}
console.groupEnd();
}

///------RESET PASWORD VIA EMAIL-----//

async function sendFirebasePasswordReset(apiKey: string, email: string) {
console.groupCollapsed('%c🔁 sendFirebasePasswordReset', 'color:#ffb300;font-weight:bold;');
try {
const resp = await fetch(
`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`,
{
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
requestType: 'PASSWORD_RESET',
email,
}),
}
);

const data = await resp.json().catch(() => ({}));
console.log('Firebase sendOobCode PASSWORD_RESET:', resp.status, data);

} catch (err) {
console.error('💥 Error en sendFirebasePasswordReset:', err);
}
console.groupEnd();
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

//--TAROT DECK--//

app.get('/api/decks', async (c) => {
  console.groupCollapsed('%c🃏 /api/decks', 'color:#ffcc80;font-weight:bold;');

  try {
    const cards = DECK.map(card => ({
      id: card.id,
      name: card.name,
      suit: card.suit,
      number: (card as any).number ?? null, // si tienes number en DECK
    }));

    console.log('Cartas enviadas (DECK):', cards.length);
    console.groupEnd();
    return c.json(cards);        // 👈👈 OJO: devolvemos UN ARRAY, no { ok, cards }
  } catch (err) {
    console.error('💥 /api/decks error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});



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
     updated_at INTEGER,
     last_daily TEXT
   )
 `).run();

try {
const info = await env.DB.prepare(
`SELECT 1 AS ok FROM pragma_table_info('drucoins') WHERE name='last_daily' LIMIT 1`
)
.first<{ ok: number }>();

if (!info?.ok) {
await env.DB.prepare(`ALTER TABLE drucoins ADD COLUMN last_daily TEXT`).run();
}
} catch (err) {
console.warn('⚠️ No se pudo asegurar columna last_daily:', err);
}

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

// ✅ Solo crea si no existe, con saldo inicial 2
await env.DB.prepare(
'INSERT OR IGNORE INTO drucoins(uid, balance, updated_at, last_daily) VALUES(?, 2, ?, NULL)'
)
.bind(uid, Date.now())
.run();

console.groupEnd();
}


export async function applyDailyDrucoin(env: Env, uid: string): Promise<number> {
console.groupCollapsed(
'%c🌙 applyDailyDrucoin()',
'color:#4fc3f7;font-weight:bold;'
);

await ensureDrucoinWallet(env, uid);

const row = await env.DB.prepare(
`SELECT balance, last_daily FROM drucoins WHERE uid=?`
)
.bind(uid)
.first<{ balance: number; last_daily: string | null }>();

if (!row) {
console.warn('⚠️ Wallet no disponible tras ensureDrucoinWallet');
console.groupEnd();
return 0;
}

const todayKey = new Date().toISOString().slice(0, 10);
let balance = row.balance ?? 0;

if (!row.last_daily || row.last_daily !== todayKey) {
console.log('→ Aplicando bono diario de +1');
await env.DB.prepare(
`UPDATE drucoins
        SET balance = balance + 1,
            updated_at = ?,
            last_daily = ?
      WHERE uid = ?`
)
.bind(Date.now(), todayKey, uid)
.run();

balance += 1;
} else {
console.log('→ Bono diario ya aplicado hoy.');
}

console.groupEnd();
return balance;
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
await env.DB.prepare(
'UPDATE drucoins SET balance = balance + ?, updated_at=? WHERE uid=?'
)
.bind(amount, Date.now(), uid)
.run();
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

await env.DB.prepare(
'UPDATE drucoins SET balance = balance - ?, updated_at=? WHERE uid=?'
)
.bind(amount, Date.now(), uid)
.run();
const newBalance = await getDrucoinBalance(env, uid);
console.log('Balance AFTER:', newBalance);
console.groupEnd();
return true;
}

type ReadingInsertPayload = {
uid: string;
email?: string | null;
interpretation: string;
cards?: any[];
spreadId?: string | null;
title?: string | null;
plan?: PlanId;
};



async function insertReadingRecord(env: Env, payload: ReadingInsertPayload): Promise<string> {
const plan = payload.plan ?? (await ensureUserPlan(env, payload.uid));
const title =
(payload.title?.trim() || 'Lectura guardada').slice(0, 140);
const cardsJson = JSON.stringify(payload.cards ?? []);
const id = crypto.randomUUID();

await env.DB.prepare(
`INSERT INTO readings(id, uid, email, title, interpretation, cards_json, spreadId, created_at)
    VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
)
.bind(
id,
payload.uid,
payload.email ?? null,
title,
payload.interpretation,
cardsJson,
payload.spreadId ?? null
)
.run();

await enforceReadingLimit(env, payload.uid, plan);
return id;
}

async function pruneUserItems(
env: Env,
table: 'history' | 'readings',
uid: string,
limit: number,
orderClause: string
) {
if (limit <= 0) return;

const query = `SELECT id FROM ${table} WHERE uid=? ${orderClause}`;
const rows = await env.DB.prepare(query).bind(uid).all<{ id: string }>();
const items = rows.results ?? [];
const extra = items.length - limit;
if (extra <= 0) return;

for (let i = 0; i < extra; i++) {
const target = items[i];
if (!target?.id) continue;
await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`)
.bind(target.id)
.run();
}
}

async function enforceHistoryLimit(env: Env, uid: string, plan: PlanId) {
if (plan !== 'luz') return;
await pruneUserItems(env, 'history', uid, 3, 'ORDER BY ts ASC');
}

async function enforceReadingLimit(env: Env, uid: string, plan: PlanId) {
if (plan !== 'luz') return;
await pruneUserItems(
env,
'readings',
uid,
2,
'ORDER BY datetime(created_at) ASC'
);
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
// AUTH — REGISTRO (Firebase Email + Password)
// ============================================================
app.post('/api/auth/register', async (c) => {
  console.groupCollapsed('%c📝 /api/auth/register', 'color:#00e676;font-weight:bold;');

  try {
    const body = await c.req.json().catch(() => null);

    if (!body || !body.email || !body.password) {
      console.warn('❌ Falta email o password');
      console.groupEnd();
      return c.json({ ok: false, error: 'missing_fields' }, 400);
    }

    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password).trim();

    const apiKey = c.env.FIREBASE_API_KEY || '';

    // ======================================================
    // 🔐 FIREBASE SIGNUP
    // ======================================================
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      }
    );

    const data: any = await resp.json().catch(() => ({}));
    console.log('Firebase signup response:', data);

    // ======================================================
    // ❌ ERROR DE FIREBASE (bloque único, sin duplicados)
    // ======================================================
    if (!resp.ok || !data.idToken) {
      console.warn('❌ Error Firebase:', data);

      const fbError =
        data?.error?.message ||
        data?.error?.errors?.[0]?.message ||
        'firebase_error';

      // Mapeo humano
      let userMessage = 'No se pudo crear tu cuenta. Intenta de nuevo.';

      switch (fbError) {
        case 'EMAIL_EXISTS':
          userMessage = 'Este correo ya está registrado. Prueba iniciando sesión.';
          break;

        case 'INVALID_EMAIL':
          userMessage = 'El correo no tiene un formato válido.';
          break;

        case 'MISSING_PASSWORD':
          userMessage = 'Debes indicar una contraseña.';
          break;

        default:
          if (typeof fbError === 'string' && fbError.includes('WEAK_PASSWORD')) {
            userMessage =
              'La contraseña es demasiado débil. Debe tener al menos 6 caracteres.';
          } else if (typeof fbError === 'string') {
            userMessage = `Error al registrar: ${fbError}`;
          }
          break;
      }

      console.groupEnd();
      return c.json(
        {
          ok: false,
          error: fbError,
          message: userMessage,
        },
        400
      );
    }

    // ======================================================
    // ✔️ REGISTRO EXITOSO
    // ======================================================
    const uid = data.localId;

    // Enviar verificación de email
    await sendFirebaseEmailVerification(apiKey, data.idToken);

    // Guardar usuario en DB
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users(uid, email, plan, created_at, updated_at)
       VALUES (?, ?, 'luz', ?, ?)`
    )
      .bind(uid, email, Date.now(), Date.now())
      .run();

    // Crear o asegurar billetera de DruCoins
    await ensureDrucoinWallet(c.env, uid);

    console.groupEnd();
    return c.json({ ok: true });

  } catch (err: any) {
    console.error('💥 /api/auth/register error:', err?.message || err);
    console.groupEnd();
    return c.json(
      { ok: false, error: 'internal_server_error' },
      500
    );
  }
});

//-------- HACER TIRADA-----------------//

app.post('/api/draw', async (c) => {
  try {
    // Body
    const body = await c.req.json();
    const spreadId = body.spreadId ?? 'celtic-cross-10';
    const allowsReversed = body.allowsReversed ?? true;

    // Semilla
    const seedInput = body.seed ?? Date.now().toString();
    const seedNum = hashSeed(seedInput);
    const rnd = rng32(seedNum);

    // Count
    const count = 
      spreadId === 'ppf-3' ? 3 :
      spreadId === 'free' ? 9 : 10;

    // Shuflle
    const ids = [...DECK.map(d => d.id)];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    const selected = ids.slice(0, count);

    const cards = selected.map((id, index) => ({
      position: index + 1,
      cardId: id,
      reversed: allowsReversed ? rnd() < 0.4 : false
    }));

    return c.json({
      ok: true,
      spreadId,
      seed: seedInput,
      cards
    });

  } catch (err) {
    console.error('/api/draw ERROR', err);
    return c.json({ ok: false }, 500);
  }
});

// ============================================================
// AUTH — LOGIN (Firebase Email + Password)
// ============================================================
app.post('/api/auth/login', async (c) => {
console.groupCollapsed(
'%c🔐 /api/auth/login',
'color:#2979ff;font-weight:bold;'
);

try {
const { email, password } = await c.req.json();
console.log('Email recibido:', email);

if (!email || !password) {
console.warn('❌ Falta email o password');
console.groupEnd();
return c.json({ ok: false, error: 'missing_fields' }, 400);
}

const apiKey = c.env.FIREBASE_API_KEY || '';

const resp = await fetch(
`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
{
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
email,
password,
returnSecureToken: true,
}),
}
);

const data = (await resp.json()) as FirebaseAuthResponse;
console.log('Firebase login response:', data);

if (!resp.ok || !data.idToken) {
console.warn('❌ Error Firebase:', data);
console.groupEnd();
return c.json({ ok: false, error: data?.error?.message }, 400);
}

const token = data.idToken!;

console.groupEnd();
return c.json({ ok: true, token });
} catch (err) {
console.error('💥 /api/auth/login error:', err);
console.groupEnd();
return c.json({ ok: false, error: 'internal_error' }, 500);
}
});

// ============================================================
// TURNSTILE CAPTCHA
// ============================================================


app.post('/api/captcha/verify', async (c) => {
  console.groupCollapsed(
    '%c🛡 /api/captcha/verify',
    'color:#4caf50;font-weight:bold;'
  );

  try {
    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: '' }));
    console.log('token recibido:', token);

    if (!token) {
      console.warn('❌ token vacío');
      console.groupEnd();
      return c.json({ ok: false, error: 'missing_token' }, 400);
    }

    console.log('¿TURNSTILE_SECRET definido?', !!(c.env as any).TURNSTILE_SECRET);

    const data = await verifyTurnstile(token, c.env);
    const ok = !!data.success;

    console.log('Respuesta Turnstile:', data);
    console.log('Resultado final:', ok ? '✓ válido' : '✗ inválido');

    console.groupEnd();
    return c.json({ ok, data });

  } catch (err: any) {
    console.error('💥 Error en /api/captcha/verify:', err?.message || err);
    console.groupEnd();
    return c.json({ ok: false, error: 'server_error' }, 500);
  }
});




export async function verifyTurnstile(token: string, env: Env): Promise<TurnstileResponse> {
  // Usa SIEMPRE el FormData global del runtime de Cloudflare
  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET);
  formData.append('response', token);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });

  if (!resp.ok) {
    console.error('❌ /siteverify status:', resp.status);
    throw new Error(`turnstile_http_${resp.status}`);
  }

  const json = (await resp.json()) as TurnstileResponse;
  console.log('Turnstile JSON:', json);
  return json;
}

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
console.log("Authorization header:", c.req.header("Authorization"));

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
console.log('Plan del usuario:', plan);
// ✅ DAILY BONUS PRIMERO

await ensureDrucoinWallet(c.env, uid);
const drucoins = await applyDailyDrucoin(c.env, uid);

console.log('DruCoins (post-daily):', drucoins);
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

app.delete('/api/history/:id', async (c) => {
console.groupCollapsed(
'%c🗑 /api/history/:id',
'color:#ef9a9a;font-weight:bold;'
);

try {
const historyId = c.req.param('id');
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

await c.env.DB.prepare('DELETE FROM history WHERE id=? AND uid=?')
.bind(historyId, uid)
.run();

console.log('Historial eliminado:', historyId);
console.groupEnd();
return c.json({ ok: true });
} catch (err) {
console.error('💥 /history/:id delete error:', err);
console.groupEnd();
return c.json({ ok: false, error: String(err) }, 500);
}
});

// ============= AQUÍ TERMINA LA PARTE 3/4 =============
type HFCompletionResponse = {
choices?: {
text?: string;
}[];
error?: any;
};

// ============================================================
// CARD MEANING — SIGNIFICADO INDIVIDUAL DE UNA CARTA
// ============================================================
app.post('/api/card-meaning', async (c) => {
  console.groupCollapsed('%c🔎 /api/card-meaning', 'color:#ba68c8;font-weight:bold;');

  try {
    const body = await c.req.json();

    // ============================
    //  RESOLVER ID DE CARTA
    // ============================
    const rawId =
      body.name ??
      body.cardId ??
      body.id ??
      body.code ??
      null;

    const reversed = !!body.reversed;

    console.log('Payload recibido en /card-meaning:', body);

    if (!rawId) {
      console.warn('⚠ /card-meaning sin id de carta válido:', body);
      return c.json({ ok: false, error: 'missing_card_id' }, 400);
    }

    // Mapeo a nombre bonito en español
    const displayName = cardNamesEs[rawId] ?? rawId;
    console.log(
      'Carta solicitada:',
      displayName,
      `(id: ${rawId})`,
      'Reversed:',
      reversed
    );

    // ============================
    //  AUTH (COHERENTE CON /interpret)
    // ============================
    const auth = c.req.header('Authorization') || '';
    const tokenHeader = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!tokenHeader) {
      console.warn('❌ No auth en /card-meaning');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const userData = await verifyFirebaseIdToken(tokenHeader, apiKey);

    const uid = userData.uid;
    const email = userData.email;
    const isMaster = isMasterUser(email);

    // =============================================================
    //  LIMITAR SIGNIFICADOS POR TIRADA (NO MASTER)
    // =============================================================
    if (!isMaster) {
      const used = await incrementMeaningCount(c.env, uid);
      if (!used.ok) {
        console.warn('❌ Límite de significados alcanzado');
        console.groupEnd();
        return c.json({
          ok: false,
          limit: true,
          message:
            'Límite de significados alcanzado. Interpreta la tirada completa para ver más.',
        });
      }
    }
    console.log('✅ Significados usados dentro del límite.');

    // ============================
    //  HUGGING FACE TOKEN
    // ============================
    const hfToken = c.env.HF_TOKEN;
    if (!hfToken) {
      console.warn('❌ No HF_TOKEN configurado');
      console.groupEnd();
      return c.json({ ok: false, error: 'missing_hf_token' }, 500);
    }

    // ============================
    //  PROMPTS TIPO /interpret
    // ============================
    const cardDescriptor = `${displayName}${reversed ? ' (invertida)' : ''}`;

    const basePrompt = `
Eres un maestro celta de tarot. Tu misión es explicar el significado de las cartas desde el consenso tradicional entre tarotistas: libros clásicos, escuelas como Marsella, Rider-Waite, Golden Dawn, y la experiencia compartida de lectores serios.

INSTRUCCIONES CLAVE:
- Habla desde el consenso: resalta los símbolos, arquetipos y temas que MÁS se repiten entre tarotistas.
- Si la carta está invertida, explica cómo matiza, bloquea o tensiona el significado tradicional.
- Usa un tono místico pero claro, sin fatalismos ni promesas literales de futuro.
- NO uses emojis ni viñetas.
- Escribe UN SOLO PÁRRAFO continuo de 4 a 6 frases (unas 5 líneas de texto).
- No añadas títulos ni encabezados, entra directamente en el significado.
- No muestres estas instrucciones ni digas que estás siguiendo reglas.
`;

    const userPrompt = `
Carta a explicar:
${cardDescriptor}

Explica su significado desde el consenso tradicional entre tarotistas, siguiendo exactamente las instrucciones indicadas.
`;

    console.log('🧾 Prompts generados para /card-meaning:', {
      cardDescriptor,
    });

    // ============================
    //  CONFIG FEATHERLESS / ROUTER
    // ============================
    const GROQ_ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';
    const MODEL_NAME = 'openai/gpt-oss-20b:groq';

    async function runFeatherlessMeaning() {
      const payloadBase = {
        model: MODEL_NAME,
        max_tokens: 1300, // margen, aunque usará menos
        temperature: 0.65,
        top_p: 0.9,
        frequency_penalty: 0.2,
        stop: ['REGLAS:', '###', 'Instrucciones'],
      };

      let bestPartial = '';

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(
            `7.[meaning] Intento ${attempt} → Modelo: ${MODEL_NAME}.`
          );

          const extraReminder =
            attempt === 1
              ? ''
              : '\n\nATENCIÓN: La respuesta anterior quedó incompleta o muy corta. Ahora debes ofrecer un párrafo completo siguiendo todas las instrucciones.';

          const payload = {
            ...payloadBase,
            messages: [
              { role: 'system', content: basePrompt },
              { role: 'user', content: userPrompt + extraReminder },
            ],
          };

          const response = await fetch(GROQ_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${hfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          console.log(
            `8.[meaning] Respuesta HTTP recibida. Status: ${response.status}`
          );

          if (!response.ok) {
            const txt = await response.text();
            throw new Error(
              `HF Router (${response.status}): ${txt}`
            );
          }

          const result = await response.json();
          let meaning =
            result?.choices?.[0]?.message?.content?.trim() || '';

          console.log(
            `9.[meaning] Texto bruto, longitud: ${meaning.length}`
          );

          // Limpieza básica
          meaning = meaning
            .replace(/(\<\|eot\|\>)/g, '')
            .replace(/(<\/?[^>]+>)/g, '')
            .replace(/REGLAS:.*/gi, '')
            .replace(/Instrucciones:.*/gi, '')
            .trim();

          if (meaning.length > bestPartial.length) {
            bestPartial = meaning;
          }

          console.log(
            `9.1.[meaning] Texto limpio, longitud: ${meaning.length}`
          );

          // Criterio sencillo: que haya texto razonable
          if (meaning.length >= 120) {
            return meaning;
          }

          console.warn(
            `9.2.[meaning] Texto demasiado corto (${meaning.length}). Reintentando...`
          );
        } catch (err: any) {
          console.warn(
            `7.1.[meaning] Falló intento ${attempt} del modelo ${MODEL_NAME}:`,
            err
          );
          if (attempt < 2) {
            const delay = 2000 * attempt;
            console.log(
              `7.2.[meaning] Esperando ${delay}ms antes del reintento...`
            );
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw new Error(
              `Featherless meaning failed all attempts: ${err.message}`
            );
          }
        }
      }

      if (bestPartial) {
        console.warn(
          '9.3.[meaning] Devolviendo texto parcial tras varios intentos.'
        );
        return bestPartial;
      }

      throw new Error(`Model ${MODEL_NAME} failed for meaning`);
    }

    // ============================
    //  EJECUTAR MODELO
    // ============================
    const meaning = await runFeatherlessMeaning();
    console.log('✔ Significado final:', meaning);
    console.groupEnd();

    return c.json({
      ok: true,
      meaning,
    });
  } catch (err: any) {
    console.error('💥 /api/card-meaning ERROR:', err);
    console.groupEnd();
    return c.json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});







// 🔥 Incrementa el contador. 
// Devuelve { ok: true } si todavía puede pedir meanings.
// Devuelve { ok: false } si llegó al límite.
export async function incrementMeaningCount(env: Env, uid: string) {
  const key = `meaning:${uid}`;
  const raw = await env.TAROT_LIMITS.get(key);
  let count = raw ? parseInt(raw, 10) : 0;

  count++;

  if (count > 3) {
    return { ok: false, count };
  }

  await env.TAROT_LIMITS.put(key, count.toString(), { expirationTtl: 7200 }); // 2 horas
  return { ok: true, count };
}


export async function resetMeaningCount(env: Env, uid: string) {
  const key = `meaning:${uid}`;
  await env.TAROT_LIMITS.delete(key);
}

// ============================================================
// 🔮 INTERPRETACIÓN CON FALLBACK + RETRY + VIÑETA CELTA ✧
// ============================================================





app.post('/api/interpret', async (c) => {
  console.groupCollapsed(
    '%c💫 /api/interpret (Featherless AI)',
    'color:#4CAF50;font-weight:bold;'
  );

  const controller = new AbortController();
  const TIMEOUT_MS = 120000;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const requestBody = await c.req.json();
    const { context, cards, spreadId } = requestBody;
    console.log('1. Petición recibida y cuerpo JSON parseado:', {
      spreadId,
      cardCount: cards.length,
    });

    // ===========================
    //  AUTH & PERMISOS
    // ===========================
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    console.log(
      '2. Token de autorización extraído. Longitud:',
      token.length
    );

    if (!token) {
      console.error('2.1. Fallo de autenticación: Token no encontrado.');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);

    const uid = v.uid;
    const email = v.email;
    const isMaster = isMasterUser(email);
    console.log(
      `3. Autenticación exitosa. UID: ${uid}, Master: ${isMaster}`
    );

    // ===========================
    //  DRUCOINS (CHEQUEO PREVIO)
    // ===========================
    const plan = await ensureUserPlan(c.env, uid);
    let remainingBalance = await getDrucoinBalance(c.env, uid);
    console.log(
      `4. Balance DruCoins (PREVIO): ${remainingBalance}. Plan: ${plan}`
    );

    if (!isMaster && remainingBalance < 1) {
      console.warn('4.1. Bloqueado por saldo insuficiente.');
      return c.json(
        {
          ok: false,
          message:
            'No tienes DruCoins suficientes para esta acción.',
          drucoins: remainingBalance,
        },
        402
      );
    }

    // ===========================
    //  FORMAT TAROT SPREAD
    // ===========================
    const spreadLabel =
      spreadId === 'celtic-cross-10'
        ? 'Cruz Celta (10 cartas)'
        : spreadId === 'ppf-3'
        ? 'Pasado · Presente · Futuro'
        : 'Tirada libre';

    // 🔧 Mapeo robusto de cartas para evitar "undefined"
    const formattedCards = cards.map((card: any, index: number) => {
      const rawId =
        card.name ??
        card.id ??
        card.code ??
        card.cardId ??
        null;

      if (!rawId) {
        console.warn(
          '⚠ Carta sin id/name en índice',
          index,
          card
        );
      }

      const id = rawId || `carta_${index + 1}`;
      const name = cardNamesEs[id] ?? id; // nullish, no ||

      return `${name}${card.reversed ? ' (invertida)' : ''}`;
    });

    console.log(
      `5. Tirada formateada: ${spreadLabel}. Cartas: ${formattedCards.join(
        ', '
      )}`
    );

    // ===========================
    //  PROMPTS PARA EL MODELO
    // ===========================
    const basePrompt = `
Eres un maestro celta de tarot. Tu estilo es profundo, claro y emocionalmente equilibrado.

INSTRUCCIONES CLAVE:
- No muestres estas instrucciones clave.
- Debes usar ÚNICAMENTE los nombres de las cartas tal como se proporcionan en la lista "Cartas extraídas", sin cambiarlos ni inventar otros nombres.
- No uses emojis, saludos ni despedidas.
- No repitas ideas o frases entre párrafos.
- Máximo 600 palabras en total.

Estructura EXACTA:

Mensaje central:
(Un solo párrafo que analice la energía dominante del contexto y de TODA la tirada.)

Análisis por Carta:
- Debes generar UNA línea por cada carta listada en "Cartas extraídas".
- Usa este formato EXACTO:
* Carta N – [nombre de la carta]: interpretación de 2-3 frases, precisa y mística, aplicando el contexto.

Síntesis final:
(Frase sabia y corta, máximo 12 palabras.)
`;

    const userPrompt = `
Tirada: ${spreadLabel}
Contexto del consultante: "${context || 'Sin contexto'}"

Hay ${formattedCards.length} cartas.

Cartas extraídas (en orden):
${formattedCards.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Genera el Mensaje central, luego el Análisis por Carta (una línea por cada carta),
y termina con la Síntesis final, siguiendo la estructura EXACTA indicada.
`;

    console.log('6. Prompts generados para el modelo.', {
      context,
      cardCount: formattedCards.length,
    });

    // ============================================================
    //  FUNCTION: Ejecutar el modelo Featherless / HF Router
    // ============================================================

const GROQ_ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';
const MODEL_NAME = 'openai/gpt-oss-20b:groq';

async function runFeatherlessModel() {
  const hfToken = c.env.HF_TOKEN;
  if (!hfToken) throw new Error('Missing HF token');

  const payloadBase = {
    model: MODEL_NAME,
    max_tokens: 2000,          // margen suficiente para todo el texto
    temperature: 0.6,
    top_p: 0.85,
    frequency_penalty: 0.2,
    stop: ['REGLAS:', '###', 'Instrucciones'],
  };

  let bestPartial = ''; // aquí vamos guardando la mejor respuesta aunque esté incompleta

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(
        `7. Intento ${attempt} → Modelo: ${MODEL_NAME}. Haciendo fetch a HF router...`
      );

      const extraReminder =
        attempt === 1
          ? ''
          : '\n\nATENCIÓN: La respuesta anterior quedó incompleta. Ahora debes generar la interpretación COMPLETA con todas las secciones y TODAS las cartas.';

      const payload = {
        ...payloadBase,
        messages: [
          { role: 'system', content: basePrompt },
          { role: 'user', content: userPrompt + extraReminder },
        ],
      };

      const response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      console.log(`8. Respuesta HTTP recibida. Status: ${response.status}`);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HF Router (${response.status}): ${errText}`);
      }

      const result = await response.json();

      let interpretation =
        result?.choices?.[0]?.message?.content?.trim() || '';

      console.log(
        `9. Respuesta parseada. Longitud de texto: ${interpretation.length}`
      );

      // Limpieza ligera
      interpretation = interpretation
        .replace(/(\<\|eot\|\>)/g, '')
        .replace(/(¡?Gracias[^]+$)/i, '')
        .replace(/(\*{2,}.*Licencia.*$)/i, '')
        .replace(/\*{3,}/g, '**')
        .replace(/(_{2,})/g, '')
        .replace(/[\*\_]{2,}\s*$/, '')
        .trim();

      // Guardamos la mejor respuesta parcial por si ninguna pasa el filtro “ideal”
      if (interpretation.length > bestPartial.length) {
        bestPartial = interpretation;
      }

      // ==============================
      // 🔍 Validación de estructura
      // ==============================
      const hasCentral = interpretation.includes('Mensaje central');
      const hasAnalysis = interpretation.includes('Análisis por Carta');
      const hasCarta = /\* Carta/.test(interpretation);
      const hasSynthesis = interpretation.includes('Síntesis final');

      console.log(
        `9.1. hasCentral=${hasCentral}, hasAnalysis=${hasAnalysis}, hasCarta=${hasCarta}, hasSynthesis=${hasSynthesis}`
      );

      // Criterio “bueno”: texto largo + estructura razonable
      const estructuraOk =
        interpretation.length > 350 &&
        hasCentral &&
        hasAnalysis &&
        hasCarta;

      if (estructuraOk) {
        console.log('9.2. Interpretación con estructura completa aceptada.');
        return interpretation;
      }

      console.warn(
        `9.3. Interpretación incompleta o demasiado corta. longitud=${interpretation.length}, estructuraOk=${estructuraOk}. Reintentando...`
      );
    } catch (err: any) {
      console.warn(
        `7.1. Falló intento ${attempt} del modelo ${MODEL_NAME}:`,
        err
      );
      if (attempt < 3) {
        const delay = 3000 * Math.pow(2, attempt - 1);
        console.log(`7.2. Esperando ${delay}ms antes del reintento...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        // si es error duro de red/HTTP, ahí sí lanzamos
        throw new Error(`Featherless AI failed all attempts: ${err.message}`);
      }
    }
  }

  // Si llegamos aquí es que ninguna pasó el filtro “ideal”, pero puede que tengamos algo usable
  if (bestPartial) {
    console.warn(
      '9.4. Devolviendo interpretación parcial tras varios intentos (mejor texto disponible).'
    );
    return bestPartial;
  }

  throw new Error(`Model ${MODEL_NAME} failed all attempts`);
}


    // ============================================================
    //  EJECUCIÓN DEL MODELO
    // ============================================================
    let interpretation = '';

    try {
      interpretation = await runFeatherlessModel();
      console.log(
        `10. Interpretación de ${MODEL_NAME} obtenida con éxito.`
      );
    } catch (e0: any) {
      console.error(
        `10.1. 💥 ERROR CRÍTICO: ${MODEL_NAME} falló.`,
        e0
      );
      clearTimeout(timeout);
      throw new Error(
        `Critical interpretation error: ${e0.message}`
      );
    }

    clearTimeout(timeout);
    console.log('11. Proceso de modelo finalizado.');

    // ===========================
    //  DESCONTAR DRUCOIN (NO MASTER)
    // ===========================
    if (!isMaster) {
      console.log(
        '12. Descontando 1 DruCoin (usuario NO master).'
      );
      const used = await useDrucoins(c.env, uid, 1);
      if (!used) {
        console.error(
          '12.1. Fallo al descontar DruCoin. Esto no debería pasar después de la verificación.'
        );
        return c.json({
          ok: false,
          message:
            'No se pudo descontar DruCoin. Inténtalo de nuevo.',
          drucoins: await getDrucoinBalance(c.env, uid),
        });
      }
      remainingBalance = await getDrucoinBalance(
        c.env,
        uid
      );
      console.log(
        `12.2. Descuento exitoso. Nuevo saldo: ${remainingBalance}`
      );
    } else {
      console.log(
        '12. Usuario Master, no se descuenta DruCoin.'
      );
    }

    // ===========================
    //  GUARDAR EN DB
    // ===========================
    const readingId = await insertReadingRecord(c.env, {
      uid,
      email,
      interpretation,
      cards,
      spreadId,
      title: spreadLabel,
      plan,
    });
    console.log(
      `13. Registro de lectura insertado en DB. ID: ${readingId}`
    );

    return c.json({
      ok: true,
      interpretation,
      drucoins: remainingBalance,
      readingId,
    });
  } catch (err: any) {
    console.error('💥 14. ERROR GENERAL /api/interpret:', err);
    clearTimeout(timeout);
    const errorMessage = err.message || String(err);
    if (errorMessage.includes('Featherless AI failed')) {
      return c.json(
        {
          ok: false,
          error:
            'Fallo en el servicio de interpretación de AI. Intenta de nuevo más tarde.',
          details: errorMessage,
        },
        500
      );
    }
    return c.json(
      {
        ok: false,
        error: 'Internal Server Error: ' + errorMessage,
      },
      500
    );
  } finally {
    console.groupEnd();
  }
});



// 2. Exportación de la función fetch (NECESARIO)


// 2. Exportación de la función fetch (NECESARIO)



app.post('/api/auth/reset-password', async (c) => {
console.groupCollapsed(
'%c🔁 /api/auth/reset-password',
'color:#ffb74d;font-weight:bold;'
);

try {
const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: '' }));
console.log('Email recibido para reset:', email);

if (!email) {
console.warn('❌ Falta email');
console.groupEnd();
return c.json({ ok: false, error: 'missing_email' }, 400);
}

const apiKey = c.env.FIREBASE_API_KEY || '';
await sendFirebasePasswordReset(apiKey, email);

console.groupEnd();
return c.json({ ok: true });

} catch (err) {
console.error('💥 /api/auth/reset-password error:', err);
console.groupEnd();
return c.json({ ok: false, error: 'internal_error' }, 500);
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
const plan = await ensureUserPlan(c.env, uid);

const id = await insertReadingRecord(c.env, {
uid,
email,
interpretation,
cards,
spreadId,
title,
plan,
});

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
// PAYPAL - CREAR ORDEN (Pack 2 DruCoins)
// ============================================================
app.post('/api/paypal/create-order', async (c) => {
  console.groupCollapsed('%c💳 /api/paypal/create-order', 'color:#cddc39;font-weight:bold;');

  try {
    // --- Auth Firebase (igual que en otros endpoints) ---
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      console.warn('❌ Sin token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    // --- Token PayPal ---
    const accessToken = await getPayPalAccessToken(c.env);
    const apiBase = c.env.PAYPAL_API_BASE || PAYPAL_API_BASE_DEFAULT;

    // Por ahora pack fijo de 2 DruCoins a 0.70 €
    const amountValue = '0.70';
    const coinsToGive = 2;

    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'EUR',
            value: amountValue,
          },
          custom_id: `${uid}|${coinsToGive}`,
          description: 'Pack 2 DruCoins - Meigo',
        },
      ],
    };

    const res = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[PayPal] Error create order:', res.status, errText);
      console.groupEnd();
      return c.json({ ok: false }, 500);
    }

    const data: any = await res.json();
    console.log('PayPal order creada:', data.id);

    console.groupEnd();
    return c.json({ ok: true, orderID: data.id });
  } catch (err) {
    console.error('💥 /api/paypal/create-order error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: 'internal_error' }, 500);
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

function hashSeed(seedInput: any): number {
  // FNV-1a 32-bit hash to convert any seed string into a 32-bit integer
  const s = String(seedInput ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng32(seedNum: number): () => number {
  // Mulberry32-like PRNG returning a function that yields floats in [0,1)
  let a = seedNum >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}



// Define las variables de entorno esperadas (ajusta esto según tu configuración de Worker)


// URL de la API de PayPal (Sandbox por defecto si no se proporciona en Env)
const PAYPAL_API_BASE_DEFAULT = 'https://api-m.sandbox.paypal.com';

// ============================================================
// 1. HELPERS Y AUTENTICACIÓN
// ============================================================

/**
 * Obtiene el Access Token de PayPal (Usando Basic Auth).
 * Este token se usa para todas las llamadas API subsiguientes (Bearer).
 * @param env Las variables de entorno de Cloudflare.
 * @returns El token de acceso Bearer.
 */
async function getPayPalAccessToken(env: Env): Promise<string> {
  const clientId = env.PAY_PAL_CLIENT_ID;
  const secret   = env.PAYPAL_SECRET;

  if (!clientId || !secret) {
    console.error('[PayPal] Faltan credenciales');
    throw new Error('paypal_missing_config');
  }

  const apiBase = env.PAYPAL_API_BASE || PAYPAL_API_BASE_DEFAULT;

  // KEY: Usar Basic Auth (Base64)
  const authHeader = 'Basic ' + btoa(`${clientId}:${secret}`);

  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const raw = await res.text();
  console.log('[PayPal] OAuth status:', res.status);

  if (!res.ok) {
    console.error('[PayPal] Error obteniendo token:', res.status, raw);
    throw new Error('paypal_token_failed');
  }

  let data: any;
  try {
    // Corregido el error de sintaxis: parsear el JSON
    data = JSON.parse(raw);
  } catch (e) { 
    console.error('[PayPal] JSON.parse fallo con respuesta OAuth:', e);
    throw new Error('paypal_token_json_error');
  }

  if (!data.access_token) {
    console.error('[PayPal] Respuesta OAuth sin access_token:', data);
    throw new Error('paypal_token_missing');
  }

  return data.access_token as string;
}


// ============================================================
// 2. ENDPOINT: CREAR ORDEN (handlePaypalCreateOrder)
// ============================================================

/**
 * Crea una orden de PayPal. Implementa control de precios y custom_id (seguridad).
 */
async function handlePaypalCreateOrder(c: any) {
  console.log('[Worker] /paypal/create-order');

  try {
    // 1. SEGURIDAD: Obtener y validar el UID del usuario (DEBE SER IMPLEMENTADO)
    // const user = await verifyFirebaseUser(c.req, c.env); 
    // const uid = user.uid;
    const uid = 'TEST_USER_FIREBASE_ID_123'; // ⚠️ Reemplazar con la verificación real ⚠️
    
    // 💡 SEGURIDAD: Definir el producto en el servidor (NO confiar en el frontend)
    const coinsToGive = 2; 
    const amountValue = '2.50'; 

    // 2. AUTENTICACIÓN: Obtener el Access Token (Bearer)
    const accessToken = await getPayPalAccessToken(c.env);

    const apiBase = c.env.PAYPAL_API_BASE || PAYPAL_API_BASE_DEFAULT;

    // 3. CREAR ORDEN en PayPal
    const paypalRes = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ✅ CORREGIDO: Usar Bearer Token
        Authorization: `Bearer ${accessToken}`,
        // 💡 Idempotencia: Para evitar doble creación en caso de reintento
        'PayPal-Request-Id': crypto.randomUUID(), 
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            // 💡 SEGURIDAD: custom_id para enlazar la orden al usuario y al producto
            custom_id: `${uid}|${coinsToGive}`, 
            amount: {
              currency_code: 'EUR',
              value: amountValue, 
            },
          },
        ],
        application_context: {
          user_action: 'PAY_NOW',
        },
      }),
    });

    // Manejo de errores de PayPal
    const raw = await paypalRes.text();
    if (!paypalRes.ok) {
      console.error('[Worker] Error de PayPal al crear orden:', paypalRes.status, raw);
      
      const statusToReturn = paypalRes.status >= 400 && paypalRes.status < 500 ? 400 : 500; 
      return c.json(
        { ok: false, error: 'paypal_creation_failed', status: paypalRes.status },
        statusToReturn,
      );
    }

    const paypalData: any = JSON.parse(raw);

    // 4. RESPUESTA: Devolver el ID de la orden de PayPal al cliente
    return c.json({
      ok: true,
      orderID: paypalData.id,
    });

  } catch (err) {
    console.error('💥 [Worker] Error fatal en /paypal/create-order:', err);
    // Este es el error 500 que has estado viendo (configuración, token, sintaxis)
    return c.json({ ok: false, error: 'internal_error' }, 500); 
  }
}

// ============================================================
// 3. ENDPOINT: CAPTURAR ORDEN (handlePaypalCaptureOrder)
// ============================================================

/**
 * Captura el pago y verifica la integridad de la orden antes de dar el producto.
 */
async function handlePaypalCaptureOrder(c: any) {
  try {
    // 1. SEGURIDAD: Validar usuario (quien captura)
    // const user = await verifyFirebaseUser(c.req, c.env);
    // const uid = user.uid;
    const uid = 'TEST_USER_FIREBASE_ID_123'; // ⚠️ Reemplazar ⚠️
    

    const { orderID } = await c.req.json().catch(() => ({ orderID: '' }));
    if (!orderID) {
      return c.json({ ok: false, error: 'missing_order_id' }, 400);
    }

    // 2. AUTENTICACIÓN: Obtener Access Token para la captura
    const accessToken = await getPayPalAccessToken(c.env);
    const apiBase = c.env.PAYPAL_API_BASE || PAYPAL_API_BASE_DEFAULT;

    // 3. CAPTURAR PAGO en PayPal
    const res = await fetch(`${apiBase}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`, // 🔑 Usar Bearer Token
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('[PayPal] Error capture:', res.status, txt);
      return c.json({ ok: false, error: 'capture_failed' }, 500); 
    }

    const data: any = await res.json();

    if (data.status !== 'COMPLETED') {
      return c.json({ ok: false, error: 'not_completed' }, 400);
    }

    // 4. SEGURIDAD: Verificar la custom_id para evitar manipulaciones
    const pu = data.purchase_units?.[0];
    const custom = (pu?.custom_id || '') as string;
    const [uidFromOrder, coinsStr] = custom.split('|');
    const coinsToGive = Number(coinsStr || '0') || 0;

    // 5. SEGURIDAD: UID Mismatch (la orden debe pertenecer al usuario logueado)
    if (!uidFromOrder || uidFromOrder !== uid) {
      console.warn('[PayPal] UID mismatch o custom_id faltante:', uidFromOrder, uid);
      return c.json({ ok: false, error: 'uid_mismatch' }, 403); 
    }
    
    // 💡 SUGERENCIA: Verificar también que el monto capturado coincide con el precio esperado (2.50)

    // 6. ÉXITO: Entregar el producto y registrar la transacción
    // const newBalance = await addDrucoins(c.env, uid, coinsToGive);
    const newBalance = 100 + coinsToGive; // Simulación

    return c.json({ ok: true, drucoins: newBalance, orderStatus: data.status });
  } catch (err) {
    console.error('💥 /api/paypal/capture-order error:', err);
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
}


// ============================================================
// 4. ROUTER DE HONO (Ejemplo de configuración del Worker)
// ============================================================
// (Asumiendo que has importado y configurado Hono en el inicio del Worker)

// import { Hono } from 'hono';
// const app = new Hono();

// app.post('/api/paypal/create-order', handlePaypalCreateOrder);
// app.post('/api/paypal/capture-order', handlePaypalCaptureOrder);

// export default app;
