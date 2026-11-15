CREATE TABLE IF NOT EXISTS event (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ended_at    TEXT,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  value       REAL,
  unit        TEXT,
  meta        TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_time        ON event (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_event_source_time ON event (source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_time   ON event (kind, occurred_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  last_run_at TEXT,
  last_ok_at  TEXT,
  last_error  TEXT,
  items       INTEGER NOT NULL DEFAULT 0
);
