import { TZ } from './config.js';
import { db } from './db.js';
import { localDayKey, offsetModifier } from './lib/util.js';
import { listFeed, type ApiEvent } from './feed.js';

export interface DayRow {
  day: string;
  events: number;
  commits: number;
  prs: number;
  ai: number;
  prompts: number;
  kcal: number;
  sleepH: number;
  tokens: number;
  focusMin: number;
}

export interface Overview {
  range: { days: number; from: string; to: string };
  totals: {
    events: number;
    commits: number;
    prs: number;
    aiSessions: number;
    aiPrompts: number;
    tokens: number;
    focusMinutes: number;
    kcal: number;
    sleepNights: number;
    sleepAvgH: number | null;
    trackedDays: number;
    workDays: number;
  };
  days: DayRow[];
  hours: { hour: number; kind: string; events: number }[];
  topRepos: { name: string; count: number; last: string }[];
  topProjects: { name: string; count: number; tokens: number; last: string }[];
  streak: { current: number; best: number };
  recent: ApiEvent[];
}

function offsetRange(days: number) {
  const now = Date.now();
  return {
    fromIso: new Date(now - days * 86_400_000).toISOString(),
    mod: offsetModifier(TZ),
    now,
  };
}

export function overview(days = 365): Overview {
  const { fromIso, mod, now } = offsetRange(days);

  const daily = db
    .prepare(
      `SELECT substr(datetime(occurred_at, ?), 1, 10) AS day, kind,
              COUNT(*) AS count, SUM(value) AS total,
              SUM(COALESCE(json_extract(meta, '$.tokens'), 0)) AS tokens
       FROM event WHERE occurred_at >= ?
       GROUP BY day, kind`,
    )
    .all(mod, fromIso) as {
    day: string;
    kind: string;
    count: number;
    total: number | null;
    tokens: number;
  }[];

  const dayMap = new Map<string, DayRow>();
  for (const row of daily) {
    let d = dayMap.get(row.day);
    if (!d) {
      d = {
        day: row.day,
        events: 0,
        commits: 0,
        prs: 0,
        ai: 0,
        prompts: 0,
        kcal: 0,
        sleepH: 0,
        tokens: 0,
        focusMin: 0,
      };
      dayMap.set(row.day, d);
    }
    d.events += row.count;
    if (row.kind === 'commit') d.commits += row.count;
    else if (row.kind === 'pr') d.prs += row.count;
    else if (row.kind === 'ai_session') {
      d.ai += row.count;
      d.tokens += row.tokens ?? 0;
      d.focusMin += row.total ?? 0;
    } else if (row.kind === 'ai_block') d.prompts += row.total ?? 0;
    else if (row.kind === 'activity') d.kcal += row.total ?? 0;
    else if (row.kind === 'sleep') d.sleepH += row.total ?? 0;
  }

  const daysSorted = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const hours = db
    .prepare(
      `SELECT CAST(strftime('%H', datetime(occurred_at, ?)) AS INTEGER) AS hour, kind, COUNT(*) AS events
       FROM event
       WHERE occurred_at >= ?
         AND kind IN ('commit', 'pr', 'ai_session', 'ai_block')
       GROUP BY hour, kind ORDER BY hour`,
    )
    .all(mod, fromIso) as { hour: number; kind: string; events: number }[];

  const topRepos = db
    .prepare(
      `SELECT json_extract(meta, '$.repo') AS name, COUNT(*) AS count, MAX(occurred_at) AS last
       FROM event WHERE kind = 'commit' AND occurred_at >= ?
       GROUP BY name ORDER BY count DESC LIMIT 3`,
    )
    .all(fromIso) as { name: string; count: number; last: string }[];

  const topProjects = db
    .prepare(
      `SELECT json_extract(meta, '$.project') AS name, COUNT(*) AS count,
              SUM(COALESCE(json_extract(meta, '$.tokens'), 0)) AS tokens,
              MAX(occurred_at) AS last
       FROM event WHERE kind = 'ai_session' AND occurred_at >= ?
       GROUP BY name ORDER BY count DESC LIMIT 3`,
    )
    .all(fromIso) as { name: string; count: number; tokens: number; last: string }[];

  const workOf = (d: DayRow) => d.commits + d.prs + d.ai + d.prompts;
  const present = new Set(daysSorted.filter((d) => workOf(d) > 0).map((d) => d.day));
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...present].sort()) {
    const t = Date.parse(`${day}T00:00:00Z`);
    if (prev && t - Date.parse(`${prev}T00:00:00Z`) === 86_400_000) run += 1;
    else run = 1;
    prev = day;
    if (run > best) best = run;
  }

  let current = 0;
  const today = localDayKey(new Date(), TZ);
  const cursor = new Date(Date.parse(`${today}T00:00:00Z`));
  if (!present.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (!present.has(key)) break;
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  const totals = daysSorted.reduce(
    (acc, d) => ({
      events: acc.events + d.events,
      commits: acc.commits + d.commits,
      prs: acc.prs + d.prs,
      aiSessions: acc.aiSessions + d.ai,
      aiPrompts: acc.aiPrompts + d.prompts,
      tokens: acc.tokens + d.tokens,
      kcal: acc.kcal + d.kcal,
      sleepNights: acc.sleepNights + (d.sleepH > 0 ? 1 : 0),
      sleepHours: acc.sleepHours + d.sleepH,
    }),
    {
      events: 0,
      commits: 0,
      prs: 0,
      aiSessions: 0,
      aiPrompts: 0,
      tokens: 0,
      kcal: 0,
      sleepNights: 0,
      sleepHours: 0,
    },
  );

  const focusMinutes = db
    .prepare(
      `SELECT SUM(value) AS v FROM event WHERE kind = 'ai_session' AND occurred_at >= ?`,
    )
    .get(fromIso) as { v: number | null };

  return {
    range: { days, from: fromIso, to: new Date(now).toISOString() },
    totals: {
      events: totals.events,
      commits: totals.commits,
      prs: totals.prs,
      aiSessions: totals.aiSessions,
      aiPrompts: totals.aiPrompts,
      tokens: totals.tokens,
      focusMinutes: Math.round(focusMinutes.v ?? 0),
      kcal: Math.round(totals.kcal),
      sleepNights: totals.sleepNights,
      sleepAvgH: totals.sleepNights
        ? Number((totals.sleepHours / totals.sleepNights).toFixed(2))
        : null,
      trackedDays: present.size,
      workDays: present.size,
    },
    days: daysSorted,
    hours,
    topRepos,
    topProjects,
    streak: { current, best },
    recent: listFeed({ limit: 14 }).events,
  };
}
