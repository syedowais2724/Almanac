import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sax from 'sax';
import { INBOX_DIR, TZ } from '../config.js';
import type { LifeEvent, LifeSource, SyncContext, SyncResult } from '../types.js';
import { writeEvents } from '../db.js';
import { localDayKey, localToIso, makeId } from '../lib/util.js';

const SOURCE = 'apple-health';
const XML = join(INBOX_DIR, 'apple_health_export', 'export.xml');
const ZIP = join(INBOX_DIR, 'export.zip');

const SEGMENT_GAP_MS = 45 * 60_000;
const MIN_NIGHT_MS = 60 * 60_000;
const MAX_NIGHT_MS = 16 * 60 * 60_000;

const APPLE_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/;

function appleDate(value: string | undefined): number | null {
  if (!value) return null;
  const m = APPLE_DATE.exec(value.trim());
  if (!m) return null;
  const parsed = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureXml(): string | null {
  if (existsSync(XML)) return XML;
  if (!existsSync(ZIP)) return null;
  try {
    execFileSync('tar', ['-xf', ZIP, '-C', INBOX_DIR], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return existsSync(XML) ? XML : null;
}

interface Segment {
  start: number;
  end: number;
}

interface Activity {
  date: string;
  active: number;
  goal: number;
  exercise: number;
  stand: number;
}

export const appleHealth: LifeSource = {
  name: SOURCE,
  label: 'Apple Health export',
  enabled: () => existsSync(XML) || existsSync(ZIP),

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const xml = ensureXml();
    if (!xml) {
      return { scanned: 0, written: 0, skipped: `no export at ${INBOX_DIR}` };
    }

    const mtimeMs = statSync(xml).mtimeMs;
    if (ctx.since && mtimeMs <= Date.parse(ctx.since)) {
      return { scanned: 0, written: 0 };
    }

    const segments: Segment[] = [];
    const activities: Activity[] = [];
    let scanned = 0;

    const parser = sax.createStream(true, { lowercase: false, trim: true });

    await new Promise<void>((resolve, reject) => {
      parser.on('opentag', (node: sax.Tag | sax.QualifiedTag) => {
        if (node.name === 'Record') {
          const attrs = node.attributes as Record<string, string>;
          if (attrs.type !== 'HKCategoryTypeIdentifierSleepAnalysis') return;
          const start = appleDate(attrs.startDate);
          const end = appleDate(attrs.endDate);
          if (start === null || end === null || end <= start) return;
          scanned++;
          segments.push({ start, end });
        } else if (node.name === 'ActivitySummary') {
          const attrs = node.attributes as Record<string, string>;
          const date = attrs.dateComponents;
          const active = Number(attrs.activeEnergyBurned);
          if (!date || !Number.isFinite(active) || active <= 0) return;
          scanned++;
          activities.push({
            date,
            active,
            goal: Number(attrs.activeEnergyBurnedGoal) || 0,
            exercise: Number(attrs.appleExerciseTime) || 0,
            stand: Number(attrs.appleStandHours) || 0,
          });
        }
      });
      parser.on('error', reject);
      parser.on('end', () => resolve());
      createReadStream(xml).pipe(parser);
    });

    const merged: Segment[] = [];
    for (const seg of segments.sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last && seg.start - last.end <= SEGMENT_GAP_MS) {
        if (seg.end > last.end) last.end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }

    const byNight = new Map<string, Segment>();
    for (const seg of merged) {
      const duration = seg.end - seg.start;
      if (duration < MIN_NIGHT_MS || duration > MAX_NIGHT_MS) continue;
      const night = localDayKey(new Date(seg.end), TZ);
      const existing = byNight.get(night);
      if (!existing || duration > existing.end - existing.start) byNight.set(night, seg);
    }

    const clock = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    const patternCounts = new Map<string, number>();
    for (const seg of byNight.values()) {
      const pattern = `${clock(seg.start)}|${clock(seg.end)}`;
      patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
    }

    const events: LifeEvent[] = [];
    let scheduleRows = 0;

    for (const [night, seg] of byNight) {
      const pattern = `${clock(seg.start)}|${clock(seg.end)}`;
      if ((patternCounts.get(pattern) ?? 0) >= 5) {
        scheduleRows++;
        continue;
      }
      const hours = (seg.end - seg.start) / 3_600_000;
      events.push({
        id: makeId(SOURCE, 'in-bed', night),
        source: SOURCE,
        kind: 'sleep',
        occurredAt: new Date(seg.start).toISOString(),
        endedAt: new Date(seg.end).toISOString(),
        title: 'In bed',
        subtitle: `${clock(seg.start)} → ${clock(seg.end)} · phone estimate`,
        value: Number(hours.toFixed(2)),
        unit: 'h',
        meta: { night, minutes: Math.round((seg.end - seg.start) / 60_000), source: 'iPhone InBed' },
      });
    }

    if (scheduleRows > 0) {
      ctx.log(`dropped ${scheduleRows} nights matching a repeated bedtime schedule`);
    }

    for (const day of activities) {
      const [y, m, d] = day.date.split('-').map(Number);
      const occurredAt = localToIso(y, m, d, 22, TZ);
      if (Date.parse(occurredAt) > Date.now()) continue;
      const extras = [];
      if (day.exercise > 0) extras.push(`exercise ${day.exercise} min`);
      if (day.stand > 0) extras.push(`stand ${day.stand} h`);
      extras.push(`goal ${day.goal} kcal`);
      events.push({
        id: makeId(SOURCE, 'activity', day.date),
        source: SOURCE,
        kind: 'activity',
        occurredAt,
        title: 'Activity rings',
        subtitle: extras.join(' · '),
        value: Math.round(day.active),
        unit: 'kcal',
        meta: {
          date: day.date,
          activeKcal: day.active,
          goalKcal: day.goal,
          exerciseMinutes: day.exercise,
          standHours: day.stand,
        },
      });
    }

    const written = writeEvents(events);
    return { scanned, written };
  },
};
