import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST, PORT, TOKEN } from './config.js';
import { dayEvents, listFeed, sourcesInUse, summary } from './feed.js';
import { overview } from './dashboard.js';
import { listSyncState } from './db.js';
import { runSync } from './runner.js';

const page = readFileSync(join(import.meta.dirname, 'web', 'index.html'), 'utf8');
const dashboard = readFileSync(join(import.meta.dirname, 'web', 'dashboard.html'), 'utf8');

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!TOKEN) return next();
  const header = req.get('authorization') ?? '';
  const given = header.startsWith('Bearer ')
    ? header.slice(7)
    : typeof req.query.token === 'string'
      ? req.query.token
      : '';
  if (given && sameSecret(given, TOKEN)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/', (_req, res) => {
  res.type('html').send(dashboard);
});

app.get('/feed', (_req, res) => {
  res.type('html').send(page);
});

app.get('/v1/overview', (req, res) => {
  const days = Number(req.query.days);
  res.json(overview(Number.isFinite(days) && days > 0 ? Math.min(days, 1095) : 365));
});

app.get('/v1/feed', (req, res) => {
  const { limit, before, source, kind, q, repo, project, hour } = req.query;
  res.json(
    listFeed({
      limit: limit ? Number(limit) : undefined,
      before: typeof before === 'string' ? before : undefined,
      source: typeof source === 'string' ? source : undefined,
      kind: typeof kind === 'string' ? kind : undefined,
      q: typeof q === 'string' ? q : undefined,
      repo: typeof repo === 'string' ? repo : undefined,
      project: typeof project === 'string' ? project : undefined,
      hour: typeof hour === 'string' ? Number(hour) : undefined,
    }),
  );
});

app.get('/v1/day/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  res.json(dayEvents(date));
});

app.get('/v1/stats', (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const until = typeof req.query.until === 'string' ? req.query.until : undefined;
  res.json(summary({ since, until }));
});

app.get('/v1/sources', (_req, res) => {
  res.json({
    events: sourcesInUse(),
    sync: listSyncState(),
  });
});

app.post('/v1/sync', async (req, res) => {
  const source = typeof req.query.source === 'string' ? [req.query.source] : undefined;
  try {
    const results = await runSync(source, () => undefined);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.listen(PORT, HOST, () => {
  console.log(`almanac on http://${HOST}:${PORT}`);
});
