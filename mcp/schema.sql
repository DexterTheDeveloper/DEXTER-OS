-- Reference only: src/db.ts creates these tables on first use.
CREATE TABLE IF NOT EXISTS log (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, sent_at TEXT);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_at);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
