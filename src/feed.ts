import { db } from './db.js';
import { dayRange, offsetModifier } from './lib/util.js';
import { TZ } from './config.js';

export interface ApiEvent {
  id: string;
  source: string;
  kind: string;
  occurredAt: string;
  endedAt: string | null;
  title: string;
  subtitle: string | null;
  value: number | null;
  unit: string | null;
  meta: Record<string, unknown>;
}

interface Row {
  id: string;
  source: string;
  kind: string;
  occurred_at: string;
  ended_at: string | null;
  title: string;
  subtitle: string | null;
  value: number | null;
  unit: string | null;
  meta: string;
}

function toApi(row: Row): ApiEvent {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    occurredAt: row.occurred_at,
    endedAt: row.ended_at,
    title: row.title,
    subtitle: row.subtitle,
    value: row.value,
    unit: row.unit,
    meta,
  };
}

export interface FeedQuery {
  limit?: number;
  before?: string | null;
  source?: string | null;
  kind?: string | null;
  q?: string | null;
  repo?: string | null;
  project?: string | null;
  hour?: number | null;
}

export function listFeed(query: FeedQuery): { events: ApiEvent[]; next: string | null } {
  const limit = Math.min(Math.max(Number(query.limit ?? 25) || 25, 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];

  if (query.before) {
    const sep = query.before.lastIndexOf('|');
    const ts = sep === -1 ? query.before : query.before.slice(0, sep);
    const id = sep === -1 ? '' : query.before.slice(sep + 1);
    where.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
    args.push(ts, ts, id);
  }
  if (query.source) {
    where.push('source = ?');
    args.push(query.source);
  }
  if (query.kind) {
    where.push('kind = ?');
    args.push(query.kind);
  }
  if (query.q) {
    where.push('(title LIKE ? OR subtitle LIKE ?)');
    args.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.repo) {
    where.push("json_extract(meta, '$.repo') = ?");
    args.push(query.repo);
  }
  if (query.project) {
    where.push("json_extract(meta, '$.project') = ?");
    args.push(query.project);
  }
  if (query.hour != null && Number.isFinite(query.hour)) {
    where.push("CAST(strftime('%H', datetime(occurred_at, ?)) AS INTEGER) = ?");
    args.push(offsetModifier(TZ), query.hour);
  }

  const sql = `SELECT * FROM event
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?`;

  const rows = db.prepare(sql).all(...args, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    events: page.map(toApi),
    next: hasMore && last ? `${last.occurred_at}|${last.id}` : null,
  };
}

export function dayEvents(day: string): { day: string; range: { start: string; end: string }; events: ApiEvent[] } {
  const range = dayRange(day, TZ);
  const rows = db
    .prepare(
      `SELECT * FROM event WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at ASC`,
    )
    .all(range.start, range.end) as Row[];
  return { day, range, events: rows.map(toApi) };
}

export interface KindSummary {
  kind: string;
  source: string;
  count: number;
  total: number | null;
  unit: string | null;
}

export function summary(opts: { since?: string | null; until?: string | null }) {
  const since = opts.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const until = opts.until ?? new Date(Date.now() + 86_400_000).toISOString();

  const kinds = db
    .prepare(
      `SELECT kind, source, COUNT(*) AS count, SUM(value) AS total, MAX(unit) AS unit
       FROM event WHERE occurred_at >= ? AND occurred_at < ?
       GROUP BY kind, source ORDER BY count DESC`,
    )
    .all(since, until) as KindSummary[];

  const busiest = db
    .prepare(
      `SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count
       FROM event WHERE occurred_at >= ? AND occurred_at < ?
       GROUP BY day ORDER BY count DESC LIMIT 5`,
    )
    .all(since, until) as { day: string; count: number }[];

  const sleep = kinds.find((k) => k.kind === 'sleep');
  const byKind: Record<string, KindSummary> = {};
  for (const k of kinds) if (!byKind[k.kind]) byKind[k.kind] = k;

  return {
    range: { since, until },
    totals: {
      events: kinds.reduce((n, k) => n + k.count, 0),
      kinds: Object.keys(byKind),
      sleepNights: sleep?.count ?? 0,
      sleepAvgHours: sleep?.total ? Number((sleep.total / sleep.count).toFixed(2)) : null,
      commits: byKind['commit']?.count ?? 0,
      aiSessions: byKind['ai_session']?.count ?? 0,
      aiPrompts: byKind['ai_block']?.total ?? 0,
    },
    kinds,
    busiestDays: busiest,
  };
}

export function sourcesInUse(): { source: string; kind: string; count: number; first: string; last: string }[] {
  return db
    .prepare(
      `SELECT source, kind, COUNT(*) AS count, MIN(occurred_at) AS first, MAX(occurred_at) AS last
       FROM event GROUP BY source, kind ORDER BY source, kind`,
    )
    .all() as { source: string; kind: string; count: number; first: string; last: string }[];
}
