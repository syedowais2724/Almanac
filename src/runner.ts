import { getSource, sources } from './sources/index.js';
import { getSyncState, saveSyncState } from './db.js';
import type { LifeSource, SyncResult } from './types.js';

export interface RunResult extends SyncResult {
  source: string;
  ok: boolean;
  error?: string;
}

const OVERLAP_MS = 10 * 60_000;

export async function runSync(
  names?: string[],
  log: (msg: string) => void = console.log,
  force = false,
) {
  let targets: LifeSource[];
  if (names && names.length > 0) {
    targets = names.map((n) => {
      const found = getSource(n);
      if (!found) throw new Error(`unknown source: ${n}`);
      return found;
    });
  } else {
    targets = sources;
  }

  const results: RunResult[] = [];

  for (const source of targets) {
    const state = getSyncState(source.name);
    const startedAt = new Date().toISOString();
    const cursor = force ? null : (state?.cursor ?? null);

    if (!source.enabled()) {
      const error = 'disabled: missing configuration';
      saveSyncState({ source: source.name, lastRunAt: startedAt, error });
      log(`${source.name}: ${error}`);
      results.push({ source: source.name, ok: false, scanned: 0, written: 0, error });
      continue;
    }

    log(`${source.name}: syncing${cursor ? ` since ${cursor}` : ' (full)'}`);

    try {
      const res = await source.sync({
        since: cursor,
        log: (msg) => log(`  ${msg}`),
      });
      const finishedAt = new Date(Date.now() - OVERLAP_MS).toISOString();
      saveSyncState({
        source: source.name,
        cursor: finishedAt,
        lastRunAt: new Date().toISOString(),
        lastOk: new Date().toISOString(),
        error: null,
        items: res.written,
      });
      log(`${source.name}: ${res.written} written from ${res.scanned} scanned`);
      results.push({ source: source.name, ok: true, ...res });
    } catch (err) {
      const error = (err as Error).message;
      saveSyncState({ source: source.name, lastRunAt: new Date().toISOString(), error });
      log(`${source.name}: failed - ${error.slice(0, 200)}`);
      results.push({ source: source.name, ok: false, scanned: 0, written: 0, error });
    }
  }

  return results;
}
