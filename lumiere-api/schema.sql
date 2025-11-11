ALTER TABLE users RENAME TO users_old;


CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT,
  plan TEXT DEFAULT 'luz',
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  rt_hash TEXT NOT NULL,
  exp INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  spreadId TEXT,
  spreadLabel TEXT,
  cards_json TEXT,
  ts INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotas (
  uid TEXT NOT NULL,
  plan TEXT NOT NULL,
  period TEXT NOT NULL,
  monthly_limit INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (uid, period)
);