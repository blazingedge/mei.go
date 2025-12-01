

// functions/src/index.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';


import { DECK } from './deck';

// ======================
// Firebase Admin init
// ======================
if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

// ======================
// Types comunes
// ======================
type PlanId = 'luz' | 'sabiduria' | 'quantico';

type FirebaseUserInfo = {
  uid: string;
  email: string;
};

// ======================
// Config CORS (similar a tu Worker)
// ======================
const LOCAL_ORIGINS = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
];

const PROD_ORIGINS = [
  'https://mei-go.pages.dev',
  'https://meigo.io',
  'https://www.meigo.io',
];

function isDevOrigin(origin?: string | null) {
  if (!origin) return false;
  return LOCAL_ORIGINS.includes(origin);
}

function getAllowedOrigin(origin?: string | null): string | RegExp | (string | RegExp)[] {
  if (!origin) return PROD_ORIGINS;
  if (isDevOrigin(origin)) return LOCAL_ORIGINS;
  // en producción restringimos a los dominios buenos
  return PROD_ORIGINS;
}

// ======================
// Express app
// ======================
const app = express();

// Body JSON
app.use(express.json());

// Logging sencillo (equivalente a tu logger global)
app.use((req, _res, next) => {
  console.log('🚀 REQUEST IN', {
    method: req.method,
    url: req.url,
    origin: req.headers.origin,
  });
  next();
});

// CORS global
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = getAllowedOrigin(origin);
      callback(null, allowed as any);
    },
    credentials: true,
  })
);

// Ruta root de test
app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Meigo API root desde Firebase ✨' });
});


// ======================
// MAPA de nombres de cartas (cardNamesEs)
// ======================
const cardNamesEs: Record<string, string> = {};
for (const card of DECK) {
  cardNamesEs[card.id] = card.name;
}

// ======================
// Helpers Firebase Auth (backend)
// ======================

async function verifyFirebaseIdTokenFromHeader(req: express.Request): Promise<FirebaseUserInfo> {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token) {
    throw new Error('no_token');
  }

  const decoded = await admin.auth().verifyIdToken(token);
  const email = (decoded.email || '').toLowerCase();

  return { uid: decoded.uid, email };
}

// ======================
// RNG helpers (copiados del Worker)
// ======================
function hashSeed(seedInput: any): number {
  const s = String(seedInput ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng32(seedNum: number): () => number {
  let a = seedNum >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ======================
// ENDPOINTS MIGRADOS
// ======================

// /api/version
app.get('/version', (req, res) => {
  const env = process.env.ENV || 'firebase';
  const payload = {
    ok: true,
    version: '1.0.0-meigo-firebase',
    env,
  };
  console.log('🧭 /api/version', payload);
  res.json(payload);
});

// /api/decks
app.get('/decks', (_req, res) => {
  try {
    const cards = DECK.map(card => ({
      id: card.id,
      name: card.name,
      suit: card.suit,
      number: (card as any).number ?? null,
    }));
    console.log('🃏 /api/decks →', cards.length, 'cartas');
    res.json(cards); // igual que en el worker: array directo
  } catch (err) {
    console.error('💥 /api/decks error:', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// /api/spreads
app.get('/spreads', (_req, res) => {
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
      positions: [1, 2, 3].map(i => ({
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

  console.log('🎴 /api/spreads', spreads.length);
  res.json(spreads);
});

// /api/draw  (usa el mismo algoritmo que tu Worker)
app.post('/draw', (req, res) => {
  try {
    const body = req.body || {};
    const spreadId = body.spreadId ?? 'celtic-cross-10';
    const allowsReversed = body.allowsReversed ?? true;

    const seedInput = body.seed ?? Date.now().toString();
    const seedNum = hashSeed(seedInput);
    const rnd = rng32(seedNum);

    const count =
      spreadId === 'ppf-3'
        ? 3
        : spreadId === 'free'
        ? 9
        : 10;

    const ids = [...DECK.map(d => d.id)];
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

    console.log('🔮 /api/draw', { spreadId, count });

    res.json({
      ok: true,
      spreadId,
      seed: seedInput,
      cards,
    });
  } catch (err) {
    console.error('/api/draw ERROR', err);
    res.status(500).json({ ok: false });
  }
});


// Aquí todavía no migramos /api/interpret, /api/quota, drucoins, etc.
// Los iremos añadiendo uno a uno, reescribiendo la parte de D1/ KV a Firestore.


// ======================
// EXPORT DE LA FUNCIÓN
// ======================
import { onRequest } from "firebase-functions/v2/https";

export const api = onRequest({ region: "europe-west1" }, app);
