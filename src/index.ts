import { formatEvent } from './lib/format.js';
import { dayEvents, listFeed, sourcesInUse, summary } from './feed.js';
import { listSyncState } from './db.js';
import { runSync } from './runner.js';
import { sources } from './sources/index.js';
import { TZ } from './config.js';

const [, , command = 'serve', ...rest] = process.argv;

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (args[i + 1] && !args[i + 1].startsWith('--')) out[arg.slice(2)] = args[++i];
      else out[arg.slice(2)] = 'true';
    }
  }
  return out;
}

async function main() {
  switch (command) {
    case 'sync': {
      const f = flags(rest);
      const targets = rest.filter((a) => !a.startsWith('--'));
      const results = await runSync(targets.length ? targets : undefined, console.log, f.force === 'true');
      const failed = results.filter((r) => !r.ok);
      console.log(
        `\n${results.reduce((n, r) => n + r.written, 0)} events written, ${failed.length} source(s) not synced`,
      );
      for (const f of failed) console.log(`  ${f.source}: ${f.error}`);
      break;
    }

    case 'serve': {
      await import('./server.js');
      break;
    }

    case 'feed': {
      const f = flags(rest);
      const result = listFeed({
        limit: f.limit ? Number(f.limit) : 20,
        source: f.source ?? null,
        kind: f.kind ?? null,
        q: f.q ?? null,
        before: f.before ?? null,
      });
      for (const e of result.events) console.log(formatEvent(e, TZ));
      if (result.next) console.log(`\nnext: ${result.next}`);
      break;
    }

    case 'day': {
      const day = rest[0] ?? new Date().toISOString().slice(0, 10);
      const result = dayEvents(day);
      for (const e of result.events) console.log(formatEvent(e, TZ));
      console.log(`${result.events.length} events on ${day} (${result.range.start} .. ${result.range.end})`);
      break;
    }

    case 'stats': {
      const f = flags(rest);
      console.log(JSON.stringify(summary({ since: f.since, until: f.until }), null, 2));
      break;
    }

    case 'sources': {
      const state = listSyncState();
      for (const s of sources) {
        const row = state.find((r) => r.source === s.name);
        const enabled = s.enabled() ? 'ready' : 'needs config';
        console.log(
          `${s.name.padEnd(14)} ${enabled.padEnd(12)} last ok ${row?.last_ok_at ?? 'never'}${row?.last_error ? ` | ${row.last_error.slice(0, 80)}` : ''}`,
        );
      }
      console.log('\nevents by source:');
      for (const e of sourcesInUse()) {
        console.log(`  ${e.source.padEnd(14)} ${e.kind.padEnd(12)} ${String(e.count).padStart(6)}  ${e.first.slice(0, 10)} .. ${e.last.slice(0, 10)}`);
      }
      break;
    }

    default:
      console.log('usage: almanac <sync|serve|feed|day|stats|sources>');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
