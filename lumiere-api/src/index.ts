// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';

// =====================
// Config
// =====================
const ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];
const CDN_BASE =
  'https://pub-dd5dcc9095b64f479cded9e2d85818d9.r2.dev/assets/v1'; // R2 público

type Bindings = {
  DB: D1Database;
  HF_TOKEN?: string;
  HF2_TOKEN?: string;
  ENV?: string;
};
const app = new Hono<{ Bindings: Bindings }>();


// =====================
// CORS (global) + OPTIONS
// ===========


app.use('*', cors({
  origin: (origin) => ORIGINS.includes(origin || '') ? origin : '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));




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
const FILES_WANDS = [
  'asdebastos.webp',
  'dosdebastos.webp',
  'tresdebastos.webp',
  'cuatrodebastos.webp',
  'cincodebastos.webp',
  'seisdebastos.webp',
  'sietedebastos.webp',
  'ochodebastos.webp',
  'nuevedebastos.webp',
  'diezdebastos.webp',
  'pagedebastos.webp',
  'caballerodebastos.webp',
  'reinadebastos.webp',
  'reydebastos.webp',
] as const;


const FILES_SWORDS = [
  'asdeespadas.webp', 'dosdeespadas.webp', 'tresdeespadas.webp', 'cuatrodeespadas.webp',
  'cincodeespadas.webp', 'seisdeespadas.webp', 'sietedeespadas.webp', 'ochodeespadas.webp',
  'nuevedeespadas.webp', 'diezdeespadas.webp', 'Pagedeespadas.webp',
  'Caballerodeespadas.webp', 'Reinadeespadas.webp', 'Reydeespadas.webp',
] as const;


// === Parse helpers ===
function stripAccentsLower(s: string) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const RANK_FROM_WORD: Record<string, number> = {
  as: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  sota: 11, page: 11, pagede: 11, paged: 11, caballero: 12, reina: 13, rey: 14,
};

function parseMetaFromFilename(file: string): { rank?: number; suit?: Suit } {
  const base = stripAccentsLower(file.replace(/\.[a-z0-9]+$/i, ''));
  const tokens = base.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

  let suit: Suit | undefined;
  if (tokens.some((t) => t.includes('bastos') || t === 'bsatos')) suit = 'wands';
  if (tokens.some((t) => t.includes('espadas'))) suit = 'swords';

  let rank: number | undefined;
  for (const t of tokens) {
    if (RANK_FROM_WORD[t] != null) { rank = RANK_FROM_WORD[t]; break; }
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
    else if (start.startsWith('page') || start.startsWith('pagede')) rank = 11;
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
  const rank = parsed.rank;
  if (!suit || !rank) return null;

  const id = `${suit}-${String(rank).padStart(2, '0')}`;
  const name = `${rankNameEs(rank)} de ${suitEs(suit)}`;

  return {
    id, suit, name, keywords: [], meaningUp: '', meaningRev: '',
    imageUrl: `/cdn/cards/${file}`, // **siempre** pasa por /cdn
  };
}

function buildDeckFromFiles(): CardMeta[] {
  const out: CardMeta[] = [];
  for (const f of FILES_WANDS)  { const m = fileToCardMeta(f, 'wands');  if (m) out.push(m); }
  for (const f of FILES_SWORDS) { const m = fileToCardMeta(f, 'swords'); if (m) out.push(m); }
  out.sort((a, b) =>
    a.suit === b.suit
      ? Number(a.id.slice(-2)) - Number(b.id.slice(-2))
      : a.suit.localeCompare(b.suit)
  );
  return out;
}

const FULL_DECK = buildDeckFromFiles();

// =====================
// Spreads
// =====================
app.get('/api/spreads', (c) =>
  c.json([
    { id: 'celtic-cross-10', name: 'Cruz Celta (10)', positions: Array.from({ length: 10 }, (_, i) => ({ index: i + 1, label: `Pos ${i + 1}`, allowsReversed: true })) },
    { id: 'ppf-3', name: 'Pasado · Presente · Futuro', positions: [1, 2, 3].map((i) => ({ index: i, label: `${i}`, allowsReversed: true })) },
    { id: 'free', name: 'Libre (9)', positions: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, label: `${i + 1}`, allowsReversed: true })) },
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
// /api/draw — Genera una tirada de cartas
// =====================
app.post('/api/draw', async (c) => {
  try {
    // 🧭 Intentamos leer el body (aunque venga vacío)
    const body = (await c.req.json().catch(() => ({}))) as {
      spreadId?: string;
      seed?: string;
      allowsReversed?: boolean;
      uid?: string;
      context?: string;
    };

    console.log('[DRAW] Body recibido:', body);

    const spreadId = body.spreadId ?? 'celtic-cross-10';
    const allowsReversed = body.allowsReversed ?? true;
    const seed = body.seed ?? Date.now().toString();
    const uid = body.uid ?? 'guest';

    // 🧩 Detectar modo desarrollo
    const isDev =
      !c.env.ENV ||
      c.env.ENV === 'development' ||
      c.req.url.includes('127.0.0.1') ||
      c.req.url.includes('localhost');

    if (isDev) console.log('🧠 [DRAW] Modo desarrollo detectado: sin límite diario.');

    // 📅 Control de límite diario (solo si hay DB)
    const today = new Date().toISOString().slice(0, 10);
    const limit = 3;

    if (!isDev && uid !== 'guest' && c.env.DB) {
      try {
        const tableCheck = await c.env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='draws';"
        ).first();

        if (!tableCheck) {
          console.warn('⚠️ [DRAW] La tabla "draws" no existe. Saltando control de límite.');
        } else {
          const row = await c.env.DB
            .prepare('SELECT count FROM draws WHERE uid = ? AND day = ?')
            .bind(uid, today)
            .first<{ count: number }>();

          const used = row?.count ?? 0;
          if (used >= limit) {
            console.warn(`[DRAW] Usuario ${uid} alcanzó el límite diario (${limit}).`);
            return c.json(
              { ok: false, error: 'limit_reached', message: 'Ya hiciste tus tiradas diarias.' },
              429
            );
          }

          await c.env.DB
            .prepare('INSERT OR REPLACE INTO draws (uid, day, count) VALUES (?, ?, ?)')
            .bind(uid, today, used + 1)
            .run();
        }
      } catch (dbErr) {
        console.error('💥 [DRAW] Error accediendo a la base D1:', dbErr);
      }
    }

    // 🎯 Determinar cantidad de cartas según spread
    const count =
      spreadId === 'ppf-3' ? 3 : spreadId === 'free' ? 9 : 10;

    // 🎲 RNG determinista basado en semilla
    const hashSeed = (s: string) =>
      [...s].reduce((h, ch) => Math.imul(31, h) + ch.charCodeAt(0) | 0, 0);

    function makeRNG(seed: number) {
      let x = seed | 0;
      return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return ((x >>> 0) % 10000) / 10000; // rango [0, 1)
      };
    }

    const seedNum = hashSeed(seed);
    const rnd = makeRNG(seedNum);

    // 🔮 Probabilidad de carta invertida (ajustable)
    const reverseChance = 0.4; // 40% de invertidas

    // 🔢 Crear IDs de cartas
    const ids = FULL_DECK.map((d) => d.id);

    // 🔀 Barajar con Fisher–Yates determinista
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    const selected = ids.slice(0, count);

    // 🃏 Generar objetos carta
    const cards = selected.map((id, i) => ({
      position: i + 1,
      cardId: id,
      reversed: allowsReversed ? rnd() < reverseChance : false,
    }));

    console.log(`[DRAW] Tirada (${uid}) →`, cards.map((c) => `${c.cardId}${c.reversed ? '↓' : '↑'}`).join(', '));

    // ✅ Respuesta final
    return c.json({
      ok: true,
      spreadId,
      seed,
      uid,
      cards,
      remaining:
        isDev || uid === 'guest'
          ? '∞'
          : limit -
            ((await c.env.DB
              .prepare('SELECT count FROM draws WHERE uid = ? AND day = ?')
              .bind(uid, today)
              .first<{ count: number }>())?.count ?? 0),
    });
  } catch (err: any) {
    console.error('💥 [DRAW] Error interno:', err);
    return c.json(
      { ok: false, error: 'internal_error', message: String(err?.message ?? err) },
      500
    );
  }
});










// Proxy CDN: /cdn/* → R2 (maneja mayúsculas y minúsculas)
const R2_BASE = `${CDN_BASE}`;


app.get('/cdn/*', async (c) => {
  const key = c.req.path.replace(/^\/cdn\//, '');
  const parts = key.split('/');
  const fileName = parts.pop()!;
  const folder = parts.join('/');

  // Lista de variantes que podría tener el archivo
  const variants = [
    fileName,
    fileName.toLowerCase(),
    fileName.toUpperCase(),
    fileName.charAt(0).toUpperCase() + fileName.slice(1),
    fileName.replace(/([a-z])([A-Z])/g, '$1 $2'), // divide CamelCase
  ];

  for (const variant of variants) {
    const candidate = folder
      ? `${R2_BASE}/${folder}/${encodeURIComponent(variant)}`
      : `${R2_BASE}/${encodeURIComponent(variant)}`;

    try {
      const res = await fetch(candidate, {
        cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true },
      });

      if (res.ok) {
        const ct = res.headers.get('content-type') ?? 'image/webp';
        console.log(`✅ [CDN] Encontrado: ${candidate}`);
        return new Response(res.body, {
          status: 200,
          headers: {
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cross-Origin-Embedder-Policy': 'unsafe-none',
            'Cross-Origin-Opener-Policy': 'unsafe-none',
          },
        });
      }
    } catch (err) {
      console.warn(`❌ [CDN] Fallo al intentar ${candidate}`);
    }
  }

  console.warn(`⚠️ [CDN] Ninguna variante encontrada para: ${fileName}`);
  return c.text('not found', 404, { 'Access-Control-Allow-Origin': '*' });
});





// =====================
// =====================
// Interpretación IA (Hugging Face / Mistral) — versión corregida

// =====================
app.post('/api/interpret', async (c) => {

 
  try {
    const { context, cards } = await c.req.json<{
      context: string;
      cards: { name: string; reversed: boolean }[];
    }>();

    // Usa el token nuevo, que sí tiene permisos correctos
    const token = c.env.HF2_TOKEN || c.env.HF_TOKEN || "";

    if (!token) {
      return c.json({ ok: false, message: 'No se encontró el token HF_TOKEN/HF2_TOKEN' }, 401);
    }

 
    if (!cards?.length) {
      return c.json({ ok: false, message: 'No se proporcionaron cartas.' }, 400);
    }

    const prompt = `
Eres un guía espiritual celta con sabiduría ancestral.
Interpreta el tarot con profundidad, equilibrio y empatía.

Contexto del usuario:
"${context || 'Sin contexto proporcionado'}"

Cartas extraídas:
${cards.map(c => `- ${c.name}${c.reversed ? ' (invertida)' : ''}`).join('\n')}

Da una interpretación cálida, práctica y reflexiva que ayude al usuario a crecer espiritualmente.
`;

    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/Llama-3.1-8B-Instruct',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.85,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('❌ Error HF:', res.status, text);
      return c.json({ ok: false, message: `Error HF ${res.status}: ${text}` }, res.status);
    }

    const data = await res.json();
    const interpretation = data?.choices?.[0]?.message?.content ?? 'No se recibió respuesta del modelo.';
    return c.json({ ok: true, interpretation });
  } catch (err: any) {
    console.error('💥 [INTERPRET] Error interno:', err);
    return c.json({ ok: false, message: String(err?.message || err) }, 500);
  }
});









// =====================
// 🔧 Middleware final CORS Fix
// =====================

app.get('/debug/env', (c) => {
  return c.json({
    HF2_TOKEN: c.env.HF2_TOKEN ? '✅ cargado' : '❌ vacío',
    HF_TOKEN: c.env.HF_TOKEN ? '✅ cargado' : '❌ vacío',
    ENV: c.env.ENV || 'no definido',
  });
});

export default app;
