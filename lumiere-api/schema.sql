ALTER TABLE users RENAME TO users_old;


CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
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
