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
};
const app = new Hono<{ Bindings: Bindings }>();


// =====================
// CORS (global) + OPTIONS
// ===========
// =====================
// 🔍 ENV & UTILS
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

  // 🔹 Normaliza equivalentes localhost / 127.0.0.1
  const normalized = origin.replace('127.0.0.1', 'localhost');
  if (allowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized)) {
    return origin; // ✅ devuelve exactamente el origin que pidió el browser
  }

  // 🔹 En producción, solo devuelve la coincidencia exacta
  if (!isDev && allowed.includes(origin)) return origin;

  // 🔹 Fallback seguro (primero válido o '*')
  return allowed[0] ?? '*';
}



app.use('*', cors({
  origin: (origin, c) => {
    const env = c.env as any;
    const isDev = !env.ENV || env.ENV === 'development';
    const allowed = isDev
      ? ['http://localhost:4200', 'http://127.0.0.1:4200']
      : ['https://mei-go.pages.dev'];

    if (!origin) return allowed[0];

    // Normaliza equivalencias 127.0.0.1 ↔ localhost
    const normalized = origin.replace('127.0.0.1', 'localhost');
    const ok = allowed.some(o => o.replace('127.0.0.1', 'localhost') === normalized);

    return ok ? origin : allowed[0];
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400,
}));




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

// 🔥 Bastos
const FILES_WANDS = [
  'asdebastos.webp','dosdebastos.webp','tresdebastos.webp','cuatrodebastos.webp',
  'cincodebastos.webp','seisdebastos.webp','sietedebastos.webp','ochodebastos.webp',
  'nuevedebastos.webp','diezdebastos.webp','pagedebastos.webp',
  'caballerodebastos.webp','reinadebastos.webp','reydebastos.webp',
] as const;

// ⚔️ Espadas
const FILES_SWORDS = [
  'asdeespadas.webp','dosdeespadas.webp','tresdeespadas.webp','cuatrodeespadas.webp',
  'cincodeespadas.webp','seisdeespadas.webp','sietedeespadas.webp','ochodeespadas.webp',
  'nuevedeespadas.webp','diezdeespadas.webp','pagedeespadas.webp',
  'caballerodeespadas.webp','reinadeespadas.webp','reydeespadas.webp',
] as const;

// 💧 Copas
const FILES_CUPS = [
  'asdecopas.webp','dosdecopas.webp','tresdecopas.webp','cuatrodecopas.webp',
  'cincodecopas.webp','seisdecopas.webp','sietedecopas.webp','ochodecopas.webp',
  'nuevedecopas.webp','diezdecopas.webp','pagedecopas.webp',
  'caballerodecopas.webp','reinadecopas.webp','reydecopas.webp',
] as const;

// 🪙 Pentáculos
const FILES_PENTS = [
  'asdepentaculos.webp','dosdepentaculos.webp','tresdepentaculos.webp','cuatrodepentaculos.webp',
  'cincodepentaculos.webp','seisdepentaculos.webp','sietedepentaculos.webp','ochodepentaculos.webp',
  'nuevedepentaculos.webp','diezdepentaculos.webp','pagedepentaculos.webp',
  'caballerodepentaculos.webp','reinadepentaculos.webp','reydepentaculos.webp',
] as const;

// 🌟 Arcanos Mayores
const FILES_MAJOR = [
  'elloco.webp','elmago.webp','lagransacerdotisa.webp','laemperatriz.webp','elemperador.webp',
  'elpapa.webp','losenamorados.webp','elcarro.webp','lafuerza.webp','elermitano.webp',
  'ruedadelafortuna.webp','lajusticia.webp','elcolgado.webp','lamuerte.webp','latemplanza.webp',
  'eldiablo.webp','latorre.webp','laestrella.webp','laluna.webp','elsol.webp','eljuicio.webp','elmundo.webp',
] as const;

// === Construcción del mazo completo ===
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

  // Pentáculos
  'pentacles-01': 'As de Pentáculos',
  'pentacles-02': 'Dos de Pentáculos',
  'pentacles-03': 'Tres de Pentáculos',
  'pentacles-04': 'Cuatro de Pentáculos',
  'pentacles-05': 'Cinco de Pentáculos',
  'pentacles-06': 'Seis de Pentáculos',
  'pentacles-07': 'Siete de Pentáculos',
  'pentacles-08': 'Ocho de Pentáculos',
  'pentacles-09': 'Nueve de Pentáculos',
  'pentacles-10': 'Diez de Pentáculos',
  'pentacles-11': 'Sota de Pentáculos',
  'pentacles-12': 'Caballero de Pentáculos',
  'pentacles-13': 'Reina de Pentáculos',
  'pentacles-14': 'Rey de Pentáculos',

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
  'major-09': 'El Ermitaño',
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

// util simple para verificar Firebase ID token (sin librerías pesadas)
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
        // 🜂 Todos los Arcanos Mayores
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

  // 🪶 Forzar rank en arcanos mayores según su posición en FILES_MAJOR
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
    // ==============================
    // 🔐 Autenticación Firebase
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
        console.warn('⚠️ Token Firebase inválido:', err);
      }
    }

    // ==============================
    // 🧭 Cuerpo del request
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

    // ==============================
    // ⚙️ Detectar modo y rol
    // ==============================
    const isDev =
      !c.env.ENV ||
      c.env.ENV === 'development' ||
      c.req.url.includes('127.0.0.1') ||
      c.req.url.includes('localhost');

    if (isDev) console.log('🧠 [DRAW] Modo desarrollo detectado.');
    if (isMaster) console.log('🌟 [DRAW] MasterUser detectado (sin límites).');

    // ==============================
    // 📅 Control de límite diario
    // ==============================
    const today = new Date().toISOString().slice(0, 10);
    const limit = 2;
    let remaining = '∞';

    if (!isDev && !isMaster && uid !== 'guest' && c.env.DB) {
      try {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS draws (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL,
            email TEXT,
            day TEXT NOT NULL,
            spreadId TEXT,
            context TEXT,
            cards_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `).run();

        const row = await c.env.DB
          .prepare('SELECT COUNT(*) as count FROM draws WHERE uid = ? AND day = ?')
          .bind(uid, today)
          .first<{ count: number }>();

        const used = row?.count ?? 0;
        if (used >= limit) {
          return c.json(
            { ok: false, error: 'limit_reached', message: 'Has alcanzado tus 2 tiradas gratuitas de hoy.' },
            429
          );
        }

        remaining = String(Math.max(limit - (used + 1), 0));
      } catch (dbErr) {
        console.error('💥 [DRAW] Error accediendo a la base D1:', dbErr);
      }
    }

    

    // ==============================
    // 🔮 Generar tirada
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

    console.log(`[DRAW] Tirada (${email}) →`, cards.map(c => `${c.cardId}${c.reversed ? '↓' : '↑'}`).join(', '));

    // ==============================
    // 💾 Guardar tirada (solo usuarios reales)
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
      console.warn('⚠️ [DRAW] No se pudo guardar la tirada:', saveErr);
    }

    // ==============================
    // ✅ Respuesta final
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
    console.error('💥 [DRAW] Error interno:', err);
    return c.json({ ok: false, error: 'internal_error', message: String(err?.message ?? err) }, 500);
  }
});






// =====================
// 🔮 /api/card-meaning — Significado de carta individual (Hugging Face nuevo router)
// =====================
app.post('/api/card-meaning', async (c) => {
  try {
    const { name, reversed } = await c.req.json<{ name: string; reversed?: boolean }>();
    const token = c.env.HF_TOKEN;
    if (!token)
      return c.json({ ok: false, message: 'No se encontró el token HF_TOKEN' }, 401);

    const prompt = `
Eres un intérprete experto en tarot celta.
Explica el significado simbólico de la carta **${name}**${reversed ? ' (invertida)' : ''}.
Usa un tono reflexivo y espiritual, sin emojis ni autopromoción.
Responde en formato **Markdown** con 2 o 3 párrafos cortos.
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
      console.error('❌ Error HF:', response.status, text);
      return c.json({ ok: false, message: `Error HF ${response.status}: ${text}` });
    }

    const result = await response.json();
    let meaning = result?.choices?.[0]?.text?.trim() || '';

    meaning = meaning
      .replace(/(¡?Gracias[^]+$)/i, '')
      .replace(/(Sígueme[^]+$)/i, '')
      .replace(/\*{3,}/g, '**');

    return c.json({ ok: true, meaning });
  } catch (err: any) {
    console.error('💥 [CARD-MEANING] Error interno:', err);
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
    console.error('💥 /api/history/save error:', err);
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
    console.error('💥 /api/history/list error:', err);
    return c.json({ ok: false, message: String(err) }, 500);
  }
});







// Proxy CDN: /cdn/* → R2 (maneja mayúsculas y minúsculas)
const R2_BASE = `${CDN_BASE}`;

// ✅ Deja una sola definición de /cdn/*
// y NO fuerces a minúsculas; además, reintenta con capitalización si 404

// ✅ CDN proxy limpio (sin reintentos ni mayúsculas)
app.get('/cdn/*', async (c) => {
  const key = c.req.path.replace(/^\/cdn\//, ''); // ruta relativa dentro del bucket
  const url = `${CDN_BASE}/${encodeURI(key)}`;

  try {
    const res = await fetch(url, {
      cf: {
        cacheTtl: 60 * 60 * 24 * 30, // 30 días
        cacheEverything: true,
      },
    });

    if (!res.ok) {
      console.warn('⚠️ [CDN Proxy] 404 o error para', url);
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
    console.error('💥 [CDN Proxy] Error al obtener', url, err);
    return c.text('cdn error', 502, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }
});




// =====================
// 🌙 /api/interpret — Interpretación completa de tirada (Hugging Face nuevo router)
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

    const token = c.env.HF_TOKEN;
    if (!token)
      return c.json({ ok: false, message: 'No se encontró el token HF_TOKEN' }, 401);

    const formattedCards = cards.map((c) => {
      const name = cardNamesEs[c.name] || c.name;
      return `${name}${c.reversed ? ' (invertida)' : ''}`;
    });

    const spreadLabel =
      spreadId === 'celtic-cross-10'
        ? 'Cruz Celta (10 cartas)'
        : spreadId === 'ppf-3'
        ? 'Pasado · Presente · Futuro'
        : 'Tirada libre';

    // 💡 system prompt para guiar tono y formato
    const prompt = `
Eres un guía espiritual celta con tono poético pero conciso.
Tu estilo es reflexivo y simbólico, sin emojis, hashtags ni autopromoción.
Usa formato **Markdown**: títulos con "**", frases importantes en **negrita**, sin exagerar.
Habla en párrafos cortos (máx 3 líneas cada uno).

Interpreta esta tirada de tarot con profundidad y esperanza:

🧭 Tipo de tirada: ${spreadLabel}
💫 Contexto del consultante: "${context || 'Sin contexto'}"

Cartas extraídas:
${formattedCards.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Tu misión:
1. Explica el mensaje central de la tirada.
2. Conecta las cartas en una historia coherente.
3. Cierra con una frase de esperanza o propósito.

Escribe solo la interpretación. No incluyas redes sociales, ni despedidas, ni emojis.
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
          max_tokens: 1500,
          temperature: 0.75,
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error('❌ Error HF:', response.status, text);
      return c.json({ ok: false, message: `Error HF ${response.status}: ${text}` });
    }

    const result = await response.json();
    let interpretation = result?.choices?.[0]?.text?.trim() || '';

    // ✂️ Post-procesado: elimina firmas o repeticiones
    interpretation = interpretation
      .replace(/(¡?Gracias[^]+$)/i, '') // corta despedidas
      .replace(/(\*{2,}.*Licencia.*$)/i, '')
      .replace(/\*{3,}/g, '**')
      .replace(/(_{2,})/g, '')
      .replace(/[\*\_]{2,}\s*$/, '');

    return c.json({ ok: true, interpretation });
  } catch (err: any) {
    console.error('💥 [INTERPRET ERROR]:', err);
    return c.json({ ok: false, message: err?.message || String(err) });
  }
});
















function getUserRole(email?: string): 'master' | 'freemium' | 'guest' {
  if (!email) return 'guest';
  if (isMasterUser(email)) return 'master';
  return 'freemium';
}


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
