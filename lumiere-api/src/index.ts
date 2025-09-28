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

type Bindings = { DB: D1Database };
const app = new Hono<{ Bindings: Bindings }>();

// =====================
// CORS (global) + OPTIONS
// =====================
app.use(
  '/*',
  cors({
    origin: ORIGINS,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

app.options('/*', (c) => {
  const origin = c.req.header('Origin') ?? '';
  if (ORIGINS.includes(origin)) {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  }
  return c.body(null, 204);
});

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
  'AsdeBastos.webp', 'Dosdebastos.webp', 'Tresdebastos.webp', 'Cuatrodebastos.webp',
  'Cincodebastos.webp', 'Seisdebastos.webp', 'Sietedebastos.webp', 'Ochodebastos.webp',
  'Nuevedebastos.webp', 'Diezdebastos.webp', 'Pagedebastos.webp',
  'Caballerode bsatos.webp', 'Reinadebastos.webp', 'Reydebastos.webp',
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

app.post('/api/draw', async (c) => {
  const { spreadId = 'celtic-cross-10', seed, allowsReversed = true } =
    (await c.req.json().catch(() => ({}))) as { spreadId?: string; seed?: string; allowsReversed?: boolean };

  const count = spreadId === 'ppf-3' ? 3 : spreadId === 'free' ? 9 : 10;
  if (FULL_DECK.length < count) return c.json({ error: 'not_enough_cards', have: FULL_DECK.length, need: count }, 409);

  const sd = seed ?? Date.now().toString();
  const rnd = rng32(hashSeed(sd));
  const ids = FULL_DECK.map((d) => d.id);
  const selected = shuffle([...ids], rnd).slice(0, count);

  const cards = selected.map((id, i) => ({
    position: i + 1,
    cardId: id,
    reversed: allowsReversed ? rnd() < 0.5 : false,
  }));

  return c.json({ spreadId, seed: sd, cards });
});

// =====================
// Proxy CDN: /cdn/* → R2 (con cache) — SIEMPRE proxy (dev y prod)
// =====================
const R2_BASE = `${CDN_BASE}`;

app.get('/cdn/*', async (c) => {
  const key = c.req.path.replace(/^\/cdn\//, '');
  const safe = key.split('/').map(encodeURIComponent).join('/');
  const url  = `${R2_BASE}/${safe}`;

  try {
    const res = await fetch(url, { cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true } });
    if (!res.ok) return c.text('not found', res.status, { 'Cache-Control': 'no-store' });

    const ct = res.headers.get('content-type') ?? 'image/png';
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*', // imágenes sin CORS
        'Vary': 'Origin',
      },
    });
  } catch {
    return c.text('cdn error', 502, { 'Cache-Control': 'no-store' });
  }
});

export default app;
