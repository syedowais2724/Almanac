import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DB_PATH } from './config.js';
import type { LifeEvent } from './types.js';

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'));

const upsert = db.prepare(`
  INSERT INTO event (id, source, kind, occurred_at, ended_at, title, subtitle, value, unit, meta)
  VALUES (@id, @source, @kind, @occurred_at, @ended_at, @title, @subtitle, @value, @unit, @meta)
  ON CONFLICT(id) DO UPDATE SET
    ended_at  = excluded.ended_at,
    title     = excluded.title,
    subtitle  = excluded.subtitle,
    value     = excluded.value,
    unit      = excluded.unit,
    meta      = excluded.meta
`);

const writeTx = db.transaction((rows: LifeEvent[]) => {
  for (const e of rows) {
    upsert.run({
      id: e.id,
      source: e.source,
      kind: e.kind,
      occurred_at: e.occurredAt,
      ended_at: e.endedAt ?? null,
      title: e.title,
      subtitle: e.subtitle ?? null,
      value: e.value ?? null,
      unit: e.unit ?? null,
      meta: JSON.stringify(e.meta ?? {}),
    });
  }
  return rows.length;
});

export function writeEvents(events: LifeEvent[]): number {
  if (events.length === 0) return 0;
  return writeTx(events);
}

export interface SyncStateRow {
  source: string;
  cursor: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  items: number;
}

export function getSyncState(source: string): SyncStateRow | undefined {
  return db.prepare('SELECT * FROM sync_state WHERE source = ?').get(source) as
    | SyncStateRow
    | undefined;
}

export function listSyncState(): SyncStateRow[] {
  return db.prepare('SELECT * FROM sync_state ORDER BY source').all() as SyncStateRow[];
}

export function saveSyncState(row: {
  source: string;
  cursor?: string | null;
  lastRunAt?: string;
  lastOk?: string | null;
  error?: string | null;
  items?: number;
}): void {
  const prev = getSyncState(row.source);
  db.prepare(`
    INSERT INTO sync_state (source, cursor, last_run_at, last_ok_at, last_error, items)
    VALUES (@source, @cursor, @last_run_at, @last_ok_at, @last_error, @items)
    ON CONFLICT(source) DO UPDATE SET
      cursor      = COALESCE(excluded.cursor, sync_state.cursor),
      last_run_at = excluded.last_run_at,
      last_ok_at  = COALESCE(excluded.last_ok_at, sync_state.last_ok_at),
      last_error  = excluded.last_error,
      items       = excluded.items
  `).run({
    source: row.source,
    cursor: row.cursor ?? null,
    last_run_at: row.lastRunAt ?? new Date().toISOString(),
    last_ok_at: row.lastOk ?? null,
    last_error: row.error ?? null,
    items: row.items ?? prev?.items ?? 0,
  });
}
