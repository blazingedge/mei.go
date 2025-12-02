﻿// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { DECK } from './deck';




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
'https://meigo-app.web.app',
'https://meigo.io',
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
RESEND_FROM_EMAIL?: string;
TAROT_LIMIT: KVNamespace;
// ej: 'Meigo <no-reply@meigo.app>'

// 🔐 PayPal
  PAY_PAL_CLIENT_ID?: string;
  PAYPAL_SECRET?: string;
  PAYPAL_API_BASE?: string; // opcional, por si cambias a sandbox
};


type Env = Bindings;
let paymentsTableReady = false;
let termsTableReady = false;

// Respuesta típica de Firebase Auth (signUp / signInWithPassword)
type FirebaseAuthResponse = {
idToken?: string;
localId?: string;
email?: string;
error?: { message?: string };
};

type TurnstileResponse = {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
};


const app = new Hono<{ Bindings: Bindings }>();

// =====================
// Planes (solo para UI / subs)
// =====================
type PlanId = 'luz' | 'sabiduria' | 'quantico';
let readingsTableReady = false;
let drucoinTableReady = false;
const CURRENT_TERMS_VERSION = 1; 


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




export async function verifyTurnstile(
  token: string,
  env: Env
): Promise<TurnstileResponse> {
  // Usa SIEMPRE el FormData global del runtime de Cloudflare
  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET);
  formData.append('response', token);

  const resp = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body: formData,
    }
  );

  if (!resp.ok) {
    console.error('❌ /siteverify status:', resp.status);
    throw new Error(`turnstile_http_${resp.status}`);
  }

  const json = (await resp.json()) as TurnstileResponse;
  console.log('Turnstile JSON:', json);
  return json;
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

function isProdEnv(env: Env) {
  return env.ENV === 'production';
}

function devLog(env: Env, ...args: any[]) {
  if (!isProdEnv(env)) {
    console.log(...args);
  }
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

await resp.json().catch(() => ({}));
} catch (err) {
console.error('💥 Error en sendFirebaseEmailVerification:', err);
}
}

///------RESET PASWORD VIA EMAIL-----//

async function sendFirebasePasswordReset(apiKey: string, email: string) {
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

await resp.json().catch(() => ({}));
} catch (err) {
console.error('💥 Error en sendFirebasePasswordReset:', err);
}
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
devLog(c.env as Env, 'REQUEST', req.method, req.url);
} catch (err) {
console.error('?? Error en logger global:', err);
}

await next();
});

// =====================
// CORS (global)
// =====================
app.use(
  '*',
  cors({
    origin: (origin, c) =>
      getAllowedOrigin(origin, c.req.raw, c.env as Env),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
    credentials: true,
  })
);

// ===================== CAPTCHA PROCESSING

// ============================================================
// ✅ CAPTCHA / TURNSTILE VERIFY
// ============================================================
app.post('/api/captcha/verify', async (c) => {
  try {
    devLog(c.env as Env, '🔐 /api/captcha/verify llamado');

    const body = await c.req.json().catch(() => ({} as any));
    const token = body?.token || body?.response || '';

    if (!token) {
      devLog(c.env as Env, '⚠️ Falta token de Turnstile en el cuerpo');
      return c.json({ ok: false, error: 'missing_token' }, 400);
    }

    const secret = c.env.TURNSTILE_SECRET;
    if (!secret) {
      console.error('❌ TURNSTILE_SECRET no está configurado en el Worker');
      return c.json({ ok: false, error: 'missing_server_secret' }, 500);
    }

    // 💡 OPCIÓN A: usar tu helper verifyTurnstile
    const result = await verifyTurnstile(token, c.env as Env);

    devLog(c.env as Env, '🔍 Turnstile respuesta:', result);

    if (!result.success) {
      const codes = result['error-codes'] || [];
      console.warn('⚠️ Turnstile verification FAILED', codes);
      return c.json({
        ok: false,
        success: false,
        errorCodes: codes,
      });
    }

    return c.json({ ok: true, success: true });
  } catch (err: any) {
    console.error('💥 /api/captcha/verify ERROR:', err);
    return c.json(
      { ok: false, error: String(err?.message || err) },
      500
    );
  }
});


///AUTHENTICATION FIREBASE ////


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
          userMessage =
            'Este correo ya está registrado. Prueba iniciando sesión.';
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
      {
        ok: false,
        error: 'internal_server_error',
      },
      500
    );
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
      return c.json(
        { ok: false, error: data?.error?.message || 'firebase_error' },
        400
      );
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



// =====================
// User + “Plan” (solo para snapshot de sesión)
// =====================

async function ensureUserPlan(env: Env, uid: string): Promise<PlanId> {
devLog(env, 'ensureUserPlan UID:', uid);

const row = await env.DB.prepare('SELECT plan FROM users WHERE uid=?')
.bind(uid)
.first<{ plan: string }>();

if (row?.plan) {
devLog(env, 'Plan existente:', row.plan);
return row.plan as PlanId;
}

await env.DB.prepare(
'INSERT OR REPLACE INTO users(uid, email, plan, created_at, updated_at) VALUES(?,?,?,?,?)'
)
.bind(uid, null, 'luz', Date.now(), Date.now())
.run();

devLog(env, 'Plan inicial asignado: luz');
return 'luz';
}

/**
* ⚠️ IMPORTANTE
* A partir de ahora, la “quota” NO controla nada real.
* Solo se calcula desde el balance de DruCoins para que el frontend
* siga recibiendo un objeto quota sin romperse.
*/
async function getUserQuotaState(env: Env, uid: string) {
devLog(env, 'getUserQuotaState UID:', uid);

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

devLog(env, 'Estado virtual de quota basado en DruCoins:', state);
return state;
}

//--DRAW--//

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
      spreadId === 'ppf-3'
        ? 3
        : spreadId === 'free'
        ? 9
        : 10;

    // Shuffle
    const ids = [...DECK.map((d) => d.id)];
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

    return c.json({ ok: true, spreadId, seed: seedInput, cards });
  } catch (err) {
    console.error('/api/draw ERROR', err);
    return c.json({ ok: false }, 500);
  }
});


//--TAROT DECK--//

app.get('/api/decks', (c) => {
  const cards = DECK.map(card => ({
    id: card.id,
    name: card.name,
    suit: card.suit,
    number: (card as any).number ?? null, // si tienes number en DECK
  }));

  devLog(c.env as Env, 'DECK enviado. Cartas:', cards.length);
  return c.json(cards); // 👈 devolvemos SOLO el array, como antes
});

// ============================================================
// CARD MEANING — SIGNIFICADO INDIVIDUAL DE UNA CARTA
// ============================================================
app.post('/api/card-meaning', async (c) => {
  devLog(c.env as Env, '🔎 /api/card-meaning');

  try {
    const body = await c.req.json().catch(() => ({} as any));

    const rawId =
      body.name ??
      body.cardId ??
      body.id ??
      body.code ??
      null;

    const reversed = !!body.reversed;

    // Contexto opcional
    const context: string =
      typeof body.context === 'string'
        ? body.context
        : typeof body.question === 'string'
        ? body.question
        : '';

    devLog(c.env as Env, 'Payload /card-meaning:', {
      rawId,
      reversed,
      hasContext: !!context,
    });

    if (!rawId) {
      devLog(c.env as Env, '⚠ /card-meaning sin id de carta válido');
      return c.json({ ok: false, error: 'missing_card_id' }, 400);
    }

    // Nombre en bonito en español
    const displayName = cardNamesEs[rawId] ?? rawId;

    // ============================
    //  AUTH (igual que /interpret)
    // ============================
    const auth = c.req.header('Authorization') || '';
    const tokenHeader = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : '';

    if (!tokenHeader) {
      devLog(c.env as Env, '❌ No auth en /card-meaning');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const userData = await verifyFirebaseIdToken(tokenHeader, apiKey);

    const uid = userData.uid;
    const email = userData.email;
    const isMaster = isMasterUser(email);

    // Límite de significados por sesión (no master)
    if (!isMaster) {
      const used = await incrementMeaningCount(c.env as Env, uid);
      if (!used.ok) {
        devLog(c.env as Env, '❌ Límite de significados alcanzado');
        return c.json({
          ok: false,
          limit: true,
          message:
            'Límite de significados alcanzado. Interpreta la tirada completa para ver más.',
        });
      }
    }

    // ============================
    //  HUGGING FACE TOKEN
    // ============================
    const hfToken = c.env.HF_TOKEN;
    if (!hfToken) {
      console.warn('❌ No HF_TOKEN configurado');
      return c.json({ ok: false, error: 'missing_hf_token' }, 500);
    }

    // ============================
    //  PROMPTS
    // ============================
    const cardDescriptor = `${displayName}${reversed ? ' (invertida)' : ''}`;

    const basePrompt = `
Eres "El Meigo", un maestro celta de tarot que habla como un amigo cercano: cálido, directo y honesto, sin fatalismos.

INSTRUCCIONES CLAVE DE ESTILO Y TONO:
- Habla de tú, en confianza, como si estuvieras acompañando al consultante.
- Puedes mencionar de vez en cuando "como El Meigo siento que...", pero no en todas las frases.
- Usa siempre un lenguaje cercano y claro, sin tecnicismos innecesarios.
- Responde SIEMPRE en español, a menos que el contexto del consultante esté claramente escrito mayoritariamente en inglés y te pida explícitamente usar ese idioma.
- No introduzcas frases en inglés por tu cuenta. Si el usuario mezcló inglés, puedes respetar esas palabras, pero la explicación debe seguir en español.
- NO uses emojis ni viñetas.
- NO prometas resultados literales ni predicciones absolutas; habla de tendencias, aprendizajes y caminos posibles.

RESPECTO A LA LONGITUD:
- Escribe UN SOLO PÁRRAFO continuo de 3 a 5 frases.
- Debe sentirse más breve y directo que una interpretación de tirada completa; esto es solo un foco sobre la carta.
- No superes aproximadamente las 160–180 palabras.
- No añadas títulos ni encabezados, entra directamente en el significado.

RESPECTO AL CONTEXTO:
- Si el consultante ha dado un contexto, úsalo solo como marco suave: conecta uno o dos detalles para que sienta que le hablas a su situación, pero sin convertir esto en una tirada completa.
- El protagonismo sigue siendo el símbolo de la carta, no la historia completa.
`;

    const userPromptParts: string[] = [];

    userPromptParts.push(`Carta a explicar: ${cardDescriptor}`);

    if (context) {
      userPromptParts.push(
        `Contexto del consultante (solo para matizar la explicación, no para hacer una tirada completa): "${context}"`
      );
    } else {
      userPromptParts.push(
        `Contexto del consultante: No se proporcionó contexto explícito. Habla de manera general pero cercana.`
      );
    }

    userPromptParts.push(`
Explica su significado desde el consenso tradicional entre tarotistas (Marsella, Rider-Waite, Golden Dawn, etc.), siguiendo exactamente las instrucciones indicadas:
- tono cercano, como amigo;
- enfoque simbólico y práctico;
- todo en español salvo que el contexto pida claramente otra cosa;
- un único párrafo, 3–5 frases, sin títulos ni listas.
`);

    const userPrompt = userPromptParts.join('\n\n');

    devLog(c.env as Env, 'Prompts listos para /card-meaning', {
      cardDescriptor,
      hasContext: !!context,
    });

    // ============================
    //  CONFIG FEATHERLESS / ROUTER
    // ============================
    const GROQ_ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';
    const MODEL_NAME = 'openai/gpt-oss-20b:groq';

    async function runFeatherlessMeaning() {
      const payloadBase = {
        model: MODEL_NAME,
        max_tokens: 1300, // margen, aunque usará bastante menos
        temperature: 0.65,
        top_p: 0.9,
        frequency_penalty: 0.2,
        stop: ['REGLAS:', '###', 'Instrucciones'],
      };

      let bestPartial = '';

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          devLog(c.env as Env, `7.[meaning] Intento ${attempt} → Modelo: ${MODEL_NAME}.`);

          const extraReminder =
            attempt === 1
              ? ''
              : '\n\nATENCIÓN: La respuesta anterior quedó incompleta o muy corta. Ahora debes ofrecer un párrafo completo siguiendo todas las instrucciones, manteniendo el tono cercano de El Meigo y respondiendo en español.';

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

          devLog(c.env as Env, `8.[meaning] Status: ${response.status}`);

          if (!response.ok) {
            const txt = await response.text();
            throw new Error(`HF Router (${response.status}): ${txt}`);
          }

          const result = await response.json();
          let meaning =
            result?.choices?.[0]?.message?.content?.trim() || '';

          devLog(c.env as Env, `9.[meaning] Longitud bruta: ${meaning.length}`);

          // Limpieza básica
          meaning = meaning
            .replace(/(\<\|eot\|\>)/g, '')
            .replace(/(<\/?[^>]+>)/g, '')
            .replace(/REGLAS:.*/gi, '')
            .replace(/Instrucciones:.*/gi, '')
            .replace(/Thank you[^]+$/i, '')
            .trim();

          if (meaning.length > bestPartial.length) {
            bestPartial = meaning;
          }

          devLog(c.env as Env, `9.1.[meaning] Longitud limpia: ${meaning.length}`);

          // Criterio sencillo: que haya texto razonable pero más breve que una tirada
          if (meaning.length >= 80) {
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
            devLog(c.env as Env, `7.2.[meaning] Esperando ${delay}ms antes del reintento...`);
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
    devLog(c.env as Env, '✔ Significado final generado (longitud):', meaning.length);

    return c.json({
      ok: true,
      meaning,
    });
  } catch (err: any) {
    console.error('💥 /api/card-meaning ERROR:', err);
    return c.json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});



// Devuelve { ok: true } si todavía puede pedir meanings.
// Devuelve { ok: false } si llegó al límite.
export async function incrementMeaningCount(env: Env, uid: string) {
  const key = `meaning:${uid}`;
  const raw = await env.TAROT_LIMIT.get(key);
  let count = raw ? parseInt(raw, 10) : 0;

  count++;

  if (count > 3) {
    return { ok: false, count };
  }

  await env.TAROT_LIMIT.put(key, count.toString(), { expirationTtl: 7200 }); // 2 horas
  return { ok: true, count };
}

export async function resetMeaningCount(env: Env, uid: string) {
  const key = `meaning:${uid}`;
  await env.TAROT_LIMIT.delete(key);
}


// ============================================================
// 🔮 INTERPRETACIÓN CON FALLBACK + RETRY + TONO EL MEIGO ✧
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
      hasContext: !!context,
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
          index
        );
      }

      const id = rawId || `carta_${index + 1}`;
      const name = cardNamesEs[id] ?? id; // nullish, no ||

      return `${name}${card.reversed ? ' (invertida)' : ''}`;
    });

    console.log(
      `5. Tirada formateada: ${spreadLabel}. Total cartas: ${formattedCards.length}`
    );

    // ===========================
    //  PROMPTS PARA EL MODELO
    // ===========================
    const basePrompt = `
Eres "El Meigo", un maestro celta de tarot que habla como un amigo muy cercano: empático, claro y honesto, sin fatalismos.

INSTRUCCIONES CLAVE DE ESTILO:
- Habla SIEMPRE en segunda persona ("tú"), como si estuvieras frente al consultante en una mesa.
- Puedes mencionar en algunas frases "como El Meigo siento que...", pero no abuses de esa muletilla.
- Usa un lenguaje sencillo, cercano, sin tecnicismos que puedan sonar fríos o académicos.
- Integra el CONTEXTO del consultante: retoma sus palabras y preocupaciones, para que sienta que le hablas realmente a su situación.
- Responde SIEMPRE en español, salvo que el contexto esté claramente escrito mayoritariamente en otro idioma y el consultante lo pida explícitamente. No metas frases en inglés por iniciativa propia.
- No uses emojis ni saludos ni despedidas ("hola", "gracias por..."), entra directo al contenido.

INSTRUCCIONES SOBRE CONTENIDO Y ÉTICA:
- No prometas predicciones literales ni resultados garantizados; habla de tendencias, decisiones y aprendizajes internos.
- Sé honesto cuando la tirada muestre tensiones, pero siempre con un enfoque de apoyo y empoderamiento.
- Evita repetir la misma idea en varios párrafos; cada bloque debe aportar algo nuevo.

ESTRUCTURA EXACTA DE LA RESPUESTA:

Mensaje central:
(Un solo párrafo que analice la energía dominante del contexto y de TODA la tirada, hablando de tú y, si sirve, mencionando brevemente lo que comentaste en el contexto.)

Análisis por Carta:
- Debes generar UNA línea por cada carta listada en "Cartas extraídas".
- Usa este formato EXACTO:
* Carta N – [nombre de la carta]: interpretación de 2-3 frases, precisa, mística y cercana al contexto, sin repetir lo mismo que ya dijiste en el Mensaje central.

Síntesis final:
(Frase sabia y corta, máximo 12 palabras, como un consejo que El Meigo te susurra al oído.)

LÍMITE DE LONGITUD:
- Máximo ~700 palabras en total.
- Si puedes transmitir todo con menos palabras sin perder profundidad, mejor.
`;

    const userPrompt = `
Tirada: ${spreadLabel}
Contexto del consultante (en sus propias palabras, si lo dio):
"${context || 'Sin contexto explícito. Habla de forma general, pero con un tono cálido y cercano.'}"

Hay ${formattedCards.length} cartas.

Cartas extraídas (en orden):
${formattedCards.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Genera el Mensaje central, luego el Análisis por Carta (UNA línea por carta siguiendo el formato indicado),
y termina con la Síntesis final, siguiendo la estructura EXACTA y las instrucciones de estilo:
- tono de amigo cercano (El Meigo),
- todo en español salvo que el contexto pida claramente otra cosa,
- sin saludos ni despedidas,
- sin promesas literales de futuro.
`;

    console.log('6. Prompts generados para el modelo (sin mostrar texto completo).', {
      hasContext: !!context,
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
        max_tokens: 2600,          // ⬆️ Aumentado para permitir más desarrollo de la tirada
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
              : '\n\nATENCIÓN: La respuesta anterior quedó incompleta o con estructura parcial. Ahora debes generar la interpretación COMPLETA con todas las secciones y TODAS las cartas, manteniendo el tono cercano de El Meigo y respondiendo en español.';

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
            .replace(/Thank you[^]+$/i, '')
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
          const hasCarta = /\* Carta\s+\d+\s+–/.test(interpretation);
          const hasSynthesis = interpretation.includes('Síntesis final');

          console.log(
            `9.1. hasCentral=${hasCentral}, hasAnalysis=${hasAnalysis}, hasCarta=${hasCarta}, hasSynthesis=${hasSynthesis}`
          );

          // Criterio “bueno”: texto largo + estructura razonable
          const estructuraOk =
            interpretation.length > 400 &&
            hasCentral &&
            hasAnalysis &&
            hasCarta &&
            hasSynthesis;

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
        `10. Interpretación de ${MODEL_NAME} obtenida con éxito (no se muestra aquí por longitud).`
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


async function ensureTermsTable(env: Env) {
  if (termsTableReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS terms_acceptance (
      uid TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    )
  `).run();

  termsTableReady = true;
}

// Lee la versión aceptada por el usuario
async function getUserAcceptedTermsVersion(env: Env, uid: string): Promise<number | null> {
  await ensureTermsTable(env);

  const row = await env.DB.prepare(
    `SELECT version FROM terms_acceptance WHERE uid = ? LIMIT 1`
  )
    .bind(uid)
    .first<{ version: number }>();

  return row?.version ?? null;
}

async function upsertTermsAcceptance(env: Env, uid: string, version: number) {
  await ensureTermsTable(env);

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO terms_acceptance (uid, version, accepted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       version     = excluded.version,
       accepted_at = excluded.accepted_at`
  )
    .bind(uid, version, now)
    .run();
}


// ============================================================
// SESSION — VALIDATE
// ============================================================
app.get('/api/session/validate', async (c) => {
  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!token) {
      console.warn('❌ /session/validate sin token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);

    const uid = user.uid;
    const email = user.email;
    const role = getUserRole(email);

    // Plan + drucoins + cuota “virtual”
    const plan = await ensureUserPlan(c.env as Env, uid);
    const drucoins = await applyDailyDrucoin(c.env as Env, uid); // aplica bono diario si toca
    const quota = await getUserQuotaState(c.env as Env, uid);

    // 🔐 Términos: miramos qué versión aceptó este usuario
    const acceptedVersion =
      (await getUserAcceptedTermsVersion(c.env as Env, uid)) ?? 0;

    const needsTerms = acceptedVersion < CURRENT_TERMS_VERSION;

    devLog(c.env as Env, '/session/validate OK', {
      uid,
      email,
      role,
      plan,
      drucoins,
      acceptedVersion,
      needsTerms,
    });

    return c.json({
      ok: true,
      uid,
      email,
      role,
      plan,
      drucoins,
      quota,
      needsTerms,
      termsVersion: CURRENT_TERMS_VERSION,
    });
  } catch (err) {
    console.error('💥 /api/session/validate ERROR:', err);
    return c.json(
      { ok: false, error: 'internal_error' },
      500
    );
  }
});









app.post('/api/auth/reset-password', async (c) => {

try {
const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: '' }));
devLog(c.env as Env, 'Solicitud de reset recibida');

if (!email) {
console.warn('❌ Falta email');
return c.json({ ok: false, error: 'missing_email' }, 400);
}

const apiKey = c.env.FIREBASE_API_KEY || '';
await sendFirebasePasswordReset(apiKey, email);

return c.json({ ok: true });

} catch (err) {
console.error('💥 /api/auth/reset-password error:', err);
return c.json({ ok: false, error: 'internal_error' }, 500);
}
});


// ============================================================
// READINGS — SAVE
// ============================================================
app.post('/api/readings/save', async (c) => {
  try {
    const { title, interpretation, cards, spreadId } = await c.req.json();
    devLog(c.env as Env, 'Lectura save payload recibido');

    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ No token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const v = await verifyFirebaseIdToken(token, apiKey);
    const uid = v.uid;
    const email = v.email;

    devLog(c.env as Env, 'Usuario verificado en readings/save');
    const plan = await ensureUserPlan(c.env as Env, uid);

    const id = await insertReadingRecord(c.env as Env, {
      uid,
      email,
      interpretation,
      cards,
      spreadId,
      title,
      plan,
    });

    devLog(c.env as Env, 'Lectura guardada', id);

    return c.json({ ok: true, id });
  } catch (err) {
    console.error('💥 /readings/save ERROR:', err);
    return c.json({ ok: false, error: String(err) });
  }
});

// ============================================================
// READINGS — LIST
// ============================================================
app.get('/api/readings/list', async (c) => {

try {
const auth = c.req.header('Authorization') || '';
const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
if (!token) {
console.warn('❌ No token');
return c.json({ ok: false, error: 'unauthorized' }, 401);
}

const apiKey = c.env.FIREBASE_API_KEY || '';
const v = await verifyFirebaseIdToken(token, apiKey);
const uid = v.uid;

devLog(c.env as Env, '/readings/:id');

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

devLog(c.env as Env, 'Lecturas listadas');

return c.json({ ok: true, items });
} catch (err) {
console.error('💥 /readings/list ERROR:', err);
return c.json({ ok: false, error: String(err) });
}
});

// ============================================================
// READINGS — GET BY ID
// ============================================================
app.get('/api/readings/:id', async (c) => {

try {
const id = c.req.param('id');
devLog(c.env as Env, 'Lectura solicitada');

const auth = c.req.header('Authorization') || '';
const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
if (!token) {
console.warn('❌ No token');
return c.json({ ok: false, error: 'unauthorized' }, 401);
}

const apiKey = c.env.FIREBASE_API_KEY || '';
const v = await verifyFirebaseIdToken(token, apiKey);
const uid = v.uid;

devLog(c.env as Env, '/readings/:id');

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

devLog(c.env as Env, 'Lectura devuelta');

return c.json(result);
} catch (err) {
console.error('💥 /readings/:id ERROR:', err);
return c.json({ ok: false, error: String(err) });
}
});

// ============================================================
// PAYPAL - CREAR ORDEN (Pack 2 DruCoins)
// ============================================================
app.post('/api/paypal/create-order', async (c) => {

  try {
    // --- Auth Firebase (igual que en otros endpoints) ---
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      console.warn('❌ Sin token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    // --- Token PayPal ---
    const accessToken = await getPayPalAccessToken(c.env);
    const apiBase = c.env.PAYPAL_API_BASE;

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
      return c.json({ ok: false }, 500);
    }

    const data: any = await res.json();
    console.log('PayPal order creada:', data.id);

    return c.json({ ok: true, orderID: data.id });
  } catch (err) {
    console.error('💥 /api/paypal/create-order error:', err);
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});


// ============================================================
// CDN PROXY — /cdn/*
// ============================================================
app.get('/cdn/*', async (c) => {

const key = c.req.path.replace(/^\/cdn\//, '');
const url = `${CDN_BASE}/${encodeURI(key)}`;

devLog(c.env as Env, '/cdn request');

try {
const res = await fetch(url, {
cf: {
cacheTtl: 60 * 60 * 24 * 30,
cacheEverything: true,
},
});

if (!res.ok) {
console.warn('❌ CDN 404/ERR:', res.status);
return c.text('not found', 404);
}

devLog(c.env as Env, 'CDN OK');

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
return c.text('cdn error', 502);
}
});

// ============================================================
// EXPORT DEFAULT
// ============================================================
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

  const apiBase = env.PAYPAL_API_BASE;

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
  devLog(env, '[PayPal] OAuth status:', res.status);

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
  devLog(c.env as Env, '[Worker] /paypal/create-order');

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

    const apiBase = c.env.PAYPAL_API_BASE;

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
    const apiBase = c.env.PAYPAL_API_BASE;

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

app.post('/api/paypal/capture-order', async (c) => {
  console.groupCollapsed(
    '%c💳 /api/paypal/capture-order',
    'color:#ffca28;font-weight:bold;'
  );

  try {
    // 1) Usuario Firebase
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    if (!token) {
      console.warn('❌ Sin token');
      console.groupEnd();
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;
    const email = user.email;

    // 2) Leer orderID desde el body
    const { orderID } = await c.req.json().catch(() => ({ orderID: '' }));
    if (!orderID) {
      console.warn('❌ missing_order_id');
      console.groupEnd();
      return c.json({ ok: false, error: 'missing_order_id' }, 400);
    }

    // 3) Access token PayPal
    const accessToken = await getPayPalAccessToken(c.env as Env);
    const apiBase = c.env.PAYPAL_API_BASE;

    // 4) Capturar la orden en PayPal
    const res = await fetch(
      `${apiBase}/v2/checkout/orders/${orderID}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      console.error('[PayPal] Error capture:', res.status, txt);
      console.groupEnd();
      return c.json({ ok: false, error: 'capture_failed' }, 500);
    }

    const data: any = await res.json();
    const status = data.status || 'UNKNOWN';

    if (status !== 'COMPLETED') {
      console.warn('⚠️ Capture status no COMPLETED:', status);
      console.groupEnd();
      return c.json({ ok: false, error: 'not_completed', status }, 400);
    }

    // 5) Extraer datos útiles (purchase_unit y captura)
    const pu = data.purchase_units?.[0];
    const capture =
      pu?.payments?.captures?.[0] ||
      (data.purchase_units?.[0]?.payments?.captures?.[0] ?? null);

    const amountValue = capture?.amount?.value || '0.00';
    const currency = capture?.amount?.currency_code || 'EUR';
    const paypalCaptureId = capture?.id || null;

    // custom_id → "uid|coins"
    const custom = String(pu?.custom_id || '');
    const [uidFromOrder, coinsStr] = custom.split('|');
    const coinsToGive = Number(coinsStr || '0') || 0;

    // 6) Seguridad: UID y precio esperados
    if (!uidFromOrder || uidFromOrder !== uid) {
      console.warn('[PayPal] UID mismatch:', { uidFromOrder, uid });
      console.groupEnd();
      return c.json({ ok: false, error: 'uid_mismatch' }, 403);
    }

    // Aquí validas que REALMENTE sea tu importe de 0.70 EUR
    if (amountValue !== '0.70' || currency !== 'EUR') {
      console.warn('[PayPal] Importe inesperado:', {
        amountValue,
        currency,
      });
      console.groupEnd();
      return c.json({ ok: false, error: 'invalid_amount' }, 400);
    }

    // 7) Registrar pago en D1
    const paymentId = await insertPaymentRecord(c.env as Env, {
      uid,
      email,
      paypalOrderId: orderID,
      paypalCaptureId,
      amountValue,
      currency,
      coins: coinsToGive,
      status,
      raw: data,
    });

    // 8) Sumar DruCoins al usuario
    const newBalance = await addDrucoins(c.env as Env, uid, coinsToGive);

    // 9) Email bonito con Resend (si está configurado)
    try {
      const resendApiKey = (c.env as any).RESEND_API_KEY;
      const resendFrom = (c.env as any).RESEND_FROM_EMAIL || 'Meigo <no-reply@meigo.app>';

      if (resendApiKey && email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: resendFrom,
            to: [email],
            subject: '✨ Gracias por apoyar a Meigo',
            html: `
              <!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Gracias por tu aporte a Meigo</title>
    <style>
      /* Ojo: muchos clientes de correo ignoran CSS avanzado.
         Mantengo solo propiedades bastante básicas. */
      body {
        margin: 0;
        padding: 24px 16px; /* 👈 margen lateral */
        background-color: #f4e7d0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          sans-serif;
      }

      .wrapper {
        max-width: 520px;
        margin: 0 auto;
      }

      .card {
        background: linear-gradient(180deg, #ffe8b5 0%, #fbe2aa 40%, #fdf4dd 100%);
        border-radius: 24px;
        box-shadow: 0 14px 30px rgba(116, 72, 22, 0.25);
        overflow: hidden;
        border: 1px solid rgba(170, 120, 60, 0.35);
      }

      .header {
        padding: 32px 32px 16px 32px;
        text-align: center;
      }

      .seal {
        width: 88px;
        height: 88px;
        border-radius: 50%;
        background: radial-gradient(circle at 30% 20%, #fff7e4 0, #f1d79e 55%, #d8aa63 100%);
        margin: 0 auto 16px auto;
        border: 2px solid rgba(154, 105, 52, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        color: #7b4c1e;
        font-weight: 600;
        letter-spacing: 0.04em;
      }

      .title {
        margin: 0;
        font-size: 20px;
        color: #5c3a13;
        font-weight: 700;
      }

      .body {
        padding: 0 32px 24px 32px;
        font-size: 14px;
        line-height: 1.6;
        color: #5a3a19;
      }

      .body p {
        margin: 0 0 12px 0;
      }

      .cta-wrapper {
        text-align: center;
        padding: 8px 32px 28px 32px;
      }

      .cta-button {
        display: inline-block;
        padding: 10px 32px;
        border-radius: 999px;
        background-color: #0b7a55;
        color: #ffffff !important;
        text-decoration: none;
        font-size: 14px;
        font-weight: 600;
      }

      .cta-button:hover {
        background-color: #0d8c63;
      }

      .footer {
        border-top: 1px solid rgba(203, 164, 104, 0.5);
        padding: 14px 24px 18px 24px;
        text-align: center;
        font-size: 11px;
        color: #92714a;
        background: #f9e9c4;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="card">
        <div class="header">
          <div class="seal">
            <span>Buhí<br />Meigo</span>
          </div>
          <h1 class="title">¡Gracias por sostener la magia de Meigo!</h1>
        </div>

        <div class="body">
          <p>Hola, alma viajera.</p>
          <p>
            Tu aportación ayuda a que este grimorio digital siga creciendo, carta a carta,
            para que más personas puedan leer su historia a través de símbolos, mitos y
            pequeños búhos insomnes como este que te escribe.
          </p>
        </div>

        <div class="cta-wrapper">
          <a href="https://meigo.io" class="cta-button" target="_blank">
            Abrir Meigo
          </a>
        </div>

        <div class="footer">
          <p style="margin: 0 0 4px 0;">
            Este mensaje fue enviado por Meigo.
          </p>
          <p style="margin: 0;">
            Si no reconoces esta acción, puedes ignorar este correo.
          </p>
        </div>
      </div>
    </div>
  </body>
</html>

            `,
          }),
        });
      }
    } catch (mailErr) {
      console.warn('⚠️ Error enviando email con Resend:', mailErr);
    }

    console.log('✅ Pago registrado y DruCoins actualizados:', {
      uid,
      paymentId,
      newBalance,
    });
    console.groupEnd();

    // 10) Respuesta al FRONT
    return c.json({
      ok: true,
      drucoins: newBalance,
      coins: coinsToGive,
      orderStatus: status,
      paymentId,
    });
  } catch (err) {
    console.error('💥 /api/paypal/capture-order error:', err);
    console.groupEnd();
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});



// =====================
// 💰 DRUCOINS
// =====================


async function ensureDrucoinTable(env: Env) {
  if (drucoinTableReady) return;

  devLog(env, '🏗 ensureDrucoinTable()');

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
    ).first<{ ok: number }>();

    if (!info?.ok) {
      await env.DB.prepare(`ALTER TABLE drucoins ADD COLUMN last_daily TEXT`).run();
    }
  } catch (err) {
    console.warn('⚠️ No se pudo asegurar columna last_daily:', err);
  }

  drucoinTableReady = true;
  devLog(env, 'Tabla drucoins asegurada.');
}

async function ensureDrucoinWallet(env: Env, uid: string) {
  devLog(env, '👛 ensureDrucoinWallet()', uid);

  await ensureDrucoinTable(env);

  const todayKey = new Date().toISOString().slice(0, 10);

  // saldo inicial 2 y marcamos que el daily de HOY ya está “consumido”
  await env.DB.prepare(
    'INSERT OR IGNORE INTO drucoins(uid, balance, updated_at, last_daily) VALUES(?, 2, ?, ?)'
  )
    .bind(uid, Date.now(), todayKey)
    .run();
}

export async function applyDailyDrucoin(env: Env, uid: string): Promise<number> {
  devLog(env, '🌙 applyDailyDrucoin()', uid);

  await ensureDrucoinWallet(env, uid);

  const row = await env.DB.prepare(
    `SELECT balance, last_daily FROM drucoins WHERE uid=?`
  )
    .bind(uid)
    .first<{ balance: number; last_daily: string | null }>();

  if (!row) {
    console.warn('⚠️ Wallet no disponible tras ensureDrucoinWallet');
    return 0;
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  let balance = row.balance ?? 0;

  if (!row.last_daily || row.last_daily !== todayKey) {
    devLog(env, '→ Aplicando bono diario de +1');
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
    devLog(env, '→ Bono diario ya aplicado hoy.');
  }

  return balance;
}

async function getDrucoinBalance(env: Env, uid: string): Promise<number> {
  devLog(env, '📟 getDrucoinBalance()', uid);

  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare(
    'SELECT balance FROM drucoins WHERE uid=?'
  )
    .bind(uid)
    .first<{ balance: number }>();

  const balance = row?.balance ?? 0;
  devLog(env, 'Balance actual:', balance);
  return balance;
}

async function addDrucoins(env: Env, uid: string, amount: number): Promise<number> {
  devLog(env, '💎 addDrucoins()', uid, amount);

  if (amount <= 0) {
    const current = await getDrucoinBalance(env, uid);
    return current;
  }

  await ensureDrucoinWallet(env, uid);
  await env.DB.prepare(
    'UPDATE drucoins SET balance = balance + ?, updated_at=? WHERE uid=?'
  )
    .bind(amount, Date.now(), uid)
    .run();

  const balance = await getDrucoinBalance(env, uid);
  devLog(env, 'Balance después de sumar:', balance);
  return balance;
}

async function useDrucoins(env: Env, uid: string, amount = 1): Promise<boolean> {
  devLog(env, '💸 useDrucoins()', uid, amount);

  if (amount <= 0) return true;

  await ensureDrucoinWallet(env, uid);
  const row = await env.DB.prepare(
    'SELECT balance FROM drucoins WHERE uid=?'
  )
    .bind(uid)
    .first<{ balance: number }>();

  const balance = row?.balance ?? 0;
  devLog(env, 'Balance BEFORE:', balance);

  if (balance < amount) {
    console.warn('❌ Balance insuficiente para descontar DruCoins.');
    return false;
  }

  await env.DB.prepare(
    'UPDATE drucoins SET balance = balance - ?, updated_at=? WHERE uid=?'
  )
    .bind(amount, Date.now(), uid)
    .run();

  const newBalance = await getDrucoinBalance(env, uid);
  devLog(env, 'Balance AFTER:', newBalance);
  return true;
}


// =====================
// 🔐 Verificación de token Firebase (se usa en varias rutas)
// =====================
async function verifyFirebaseIdToken(idToken: string, apiKey: string) {
  devLog({ ENV: 'local' } as Env, 'verifyFirebaseIdToken called'); // opcional, puedes borrar esta línea si no quieres log

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
    throw new Error('invalid_token');
  }

  const data = await resp.json();
  const user = data?.users?.[0];
  if (!user) {
    console.error('❌ Firebase getAccountInfo sin usuario.');
    throw new Error('invalid_token');
  }

  return {
    uid: user.localId as string,
    email: (user.email || '').toLowerCase() as string,
  };
}

// ============================================================
// TERMS — NEEDS & ACCEPT
// ============================================================
app.get('/api/terms/needs', async (c) => {
  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ /terms/needs sin token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    devLog(c.env as Env, '/terms/needs', { uid });

    const acceptedVersion =
      (await getUserAcceptedTermsVersion(c.env as Env, uid)) ?? 0;

    const needsTerms = acceptedVersion < CURRENT_TERMS_VERSION;

    return c.json({
      ok: true,
      needsTerms,
      currentVersion: CURRENT_TERMS_VERSION,
      acceptedVersion,
    });
  } catch (err) {
    console.error('💥 /api/terms/needs ERROR:', err);
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});

// ============================================================
// TERMS — ACCEPT
// ============================================================

app.post('/api/terms/accept', async (c) => {
  try {
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      console.warn('❌ /terms/accept sin token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const apiKey = c.env.FIREBASE_API_KEY || '';
    const user = await verifyFirebaseIdToken(token, apiKey);
    const uid = user.uid;

    const body = await c.req.json().catch(() => ({} as any));
    const version: number = body.version ?? CURRENT_TERMS_VERSION;

    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-real-ip') ??
      null;
    const ua = c.req.header('user-agent') ?? null;

    devLog(c.env as Env, '/terms/accept', { uid, version });

    await upsertTermsAcceptance(c.env as Env, uid, version, {
      ip,
      userAgent: ua,
    });

    return c.json({
      ok: true,
      needsTerms: false,
      currentVersion: version,
    });
  } catch (err) {
    console.error('💥 /terms/accept ERROR:', err);
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});


// ============================================================
// READINGS — HELPERS (tabla + insert)
// ============================================================


async function ensureReadingsTable(env: Env) {
  if (readingsTableReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT,
      email TEXT,
      title TEXT,
      interpretation TEXT,
      cards_json TEXT,
      spreadId TEXT,
      plan TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `).run();

  readingsTableReady = true;
}

type ReadingInsert = {
  uid: string;
  email?: string | null;
  interpretation: string;
  cards: any[];
  spreadId?: string | null;
  title?: string | null;
  plan: PlanId;
};

async function insertReadingRecord(env: Env, data: ReadingInsert): Promise<number> {
  await ensureReadingsTable(env);

  const nowIso = new Date().toISOString();
  const cardsJson = JSON.stringify(data.cards ?? []);

  const res = await env.DB.prepare(
    `INSERT INTO readings
       (uid, email, title, interpretation, cards_json, spreadId, plan, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      data.uid,
      data.email ?? null,
      data.title ?? null,
      data.interpretation,
      cardsJson,
      data.spreadId ?? null,
      data.plan,
      nowIso,
      nowIso
    )
    .run();

  const id = (res.meta as any).last_row_id as number;
  return id;
}

//-- ASEGURAMOS DE QUE LOS PAGOS ESTEN LISTOS Y FUNCIONEN --//

async function ensurePaymentsTable(env: Env) {
  if (paymentsTableReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      uid TEXT,
      email TEXT,
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      amount_cents INTEGER,
      currency TEXT,
      coins INTEGER,
      status TEXT,
      raw_json TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `).run();

  paymentsTableReady = true;
}

async function insertPaymentRecord(
  env: Env,
  payload: {
    uid: string;
    email?: string | null;
    paypalOrderId: string;
    paypalCaptureId?: string | null;
    amountValue: string;         // "0.70"
    currency: string;            // "EUR"
    coins: number;               // 2
    status: string;              // "COMPLETED"
    raw: any;                    // respuesta completa de PayPal
  }
): Promise<string> {
  await ensurePaymentsTable(env);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const amountNumber = Number(payload.amountValue || '0');
  const amountCents = Math.round(amountNumber * 100);

  await env.DB.prepare(
    `INSERT INTO payments
      (id, uid, email, paypal_order_id, paypal_capture_id,
       amount_cents, currency, coins, status, raw_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      payload.uid,
      payload.email ?? null,
      payload.paypalOrderId,
      payload.paypalCaptureId ?? null,
      amountCents,
      payload.currency,
      payload.coins,
      payload.status,
      JSON.stringify(payload.raw),
      now,
      now
    )
    .run();

  return id;
}


