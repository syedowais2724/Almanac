import { existsSync, readFileSync } from 'node:fs';
import { COMMANDCODE_HISTORY, TZ } from '../config.js';
import type { LifeEvent, LifeSource, SyncContext, SyncResult } from '../types.js';
import { writeEvents } from '../db.js';
import { hourKeyToIso, localHourKey, makeId, safeText } from '../lib/util.js';

const SOURCE = 'commandcode';

interface Line {
  p?: string;
  t?: number;
}

export const commandcode: LifeSource = {
  name: SOURCE,
  label: 'Command Code prompts',
  enabled: () => existsSync(COMMANDCODE_HISTORY),

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    if (!existsSync(COMMANDCODE_HISTORY)) {
      return { scanned: 0, written: 0, skipped: `no history at ${COMMANDCODE_HISTORY}` };
    }

    const raw = readFileSync(COMMANDCODE_HISTORY, 'utf8');
    const buckets = new Map<string, { count: number; first: string | null }>();
    let scanned = 0;

    for (const line of raw.split('\n')) {
      if (!line.startsWith('{')) continue;
      let rec: Line;
      try {
        rec = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      if (typeof rec.t !== 'number' || !Number.isFinite(rec.t)) continue;
      scanned++;

      const at = new Date(rec.t);
      const key = localHourKey(at, TZ);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count++;
      } else {
        buckets.set(key, { count: 1, first: typeof rec.p === 'string' ? rec.p : null });
      }
    }

    const events: LifeEvent[] = [];
    for (const [key, bucket] of buckets) {
      const hint = bucket.first ? safeText(bucket.first, 80) : '';
      events.push({
        id: makeId(SOURCE, key),
        source: SOURCE,
        kind: 'ai_block',
        occurredAt: hourKeyToIso(key, TZ),
        title: `Command Code · ${bucket.count} prompt${bucket.count === 1 ? '' : 's'}`,
        subtitle: hint || null,
        value: bucket.count,
        unit: 'prompts',
        meta: { tool: 'commandcode', hour: key, prompts: bucket.count },
      });
    }

    const written = writeEvents(events);
    return { scanned, written };
  },
};
