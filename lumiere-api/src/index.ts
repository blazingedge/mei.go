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
let readingsTableReady = false;

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

//--TAROT DECK--//

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

    // Por ahora: no obligamos términos desde backend
    const currentTermsVersion = 1;
    const needsTerms = false;

    devLog(c.env as Env, '/session/validate OK', {
      uid,
      email,
      role,
      plan,
      drucoins,
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
      termsVersion: currentTermsVersion,
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

// =====================
// 💰 DRUCOINS
// =====================

let drucoinTableReady = false;

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

    // Por ahora siempre devolvemos que NO necesita aceptar términos.
    // Si luego quieres guardar versión en D1, lo cambiamos.
    const currentTermsVersion = 1;

    return c.json({
      ok: true,
      needsTerms: false,
      currentVersion: currentTermsVersion,
    });
  } catch (err) {
    console.error('💥 /api/terms/needs ERROR:', err);
    return c.json({ ok: false, error: 'internal_error' }, 500);
  }
});

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
    const version = body.version ?? 1;

    devLog(c.env as Env, '/terms/accept', { uid, version });

    // Aquí podrías guardar en D1 algo como terms_acceptance.
    // De momento solo respondemos OK.

    return c.json({
      ok: true,
      needsTerms: false,
      currentVersion: version,
    });
  } catch (err) {
    console.error('💥 /api/terms/accept ERROR:', err);
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


// ============================================================
// 4. ROUTER DE HONO (Ejemplo de configuración del Worker)
// ============================================================
// (Asumiendo que has importado y configurado Hono en el inicio del Worker)

// import { Hono } from 'hono';
// const app = new Hono();

// app.post('/api/paypal/create-order', handlePaypalCreateOrder);
// app.post('/api/paypal/capture-order', handlePaypalCaptureOrder);

// export default app;
