# Almanac

A personal API over your own life. Syncs sources into a local SQLite store, serves one unified reverse-chron feed.

## Setup

```bash
npm install
cp .env.example .env      # then fill GITHUB_TOKEN and GITHUB_USER
npm run sync
npm run serve             # http://127.0.0.1:7777
```

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | Sync every configured source |
| `npm run sync -- github` | Sync one source |
| `npm run sync -- apple-health --force` | Ignore the cursor and re-read the export |
| `npm run serve` | API + feed page on :7777 |
| `npm run feed` | Print the latest feed rows to the terminal |
| `npm run sources` | Source status and event counts |
| `npm run typecheck` | TypeScript check |

## API

| Route | Returns |
|---|---|
| `GET /v1/feed?limit=&before=&source=&kind=&q=` | Reverse-chron events, keyset paginated |
| `GET /v1/day/YYYY-MM-DD` | One local day, all sources |
| `GET /v1/stats?since=&until=` | Counts, sleep average, busiest days |
| `GET /v1/sources` | Per-source event counts and last sync |
| `POST /v1/sync?source=` | Run a sync over HTTP |

`/` renders the scrollable feed.

## Sources

- **github** — commits authored by you across all repos plus PRs you opened. Needs a classic PAT with `repo` and `read:user`.
- **claude-code** — parses `~/.claude/projects/**/*.jsonl` into one event per session: project, turns, tokens, duration. Metadata only, never message text. Subagent transcripts roll into their parent session.
- **commandcode** — `~/.commandcode/history.jsonl` grouped into hourly prompt-count blocks.
- **apple-health** — reads `inbox/apple_health_export/export.xml` (auto-extracts `inbox/export.zip`). Emits one `activity` event per day from `ActivitySummary`, and one `sleep` event per night from merged `SleepAnalysis` segments.

### Apple Health caveat

With no Apple Watch, the export contains only `HKCategoryValueSleepAnalysisInBed` samples — iPhone in-bed detection, not sleep stages. Those samples also include the iOS bedtime schedule firing identically night after night. The importer drops any start/end pair that repeats 5+ times and labels the rest `phone estimate`. Real sleep stages need a Watch or an app that writes them; drop a new export in and re-run `npm run sync -- apple-health --force`.

## Rules

- Local only. Binds `127.0.0.1`. Set `LIFE_TOKEN` to require a bearer token.
- Transcript content is never stored. Titles pass through `safeText()`, which drops anything resembling a credential.
- Re-syncing is idempotent: event ids are content hashes, so `ON CONFLICT` updates instead of duplicating.
- `data/life.db` is the store. Delete it to rebuild from scratch.

Not yet wired: claude.ai and ChatGPT `conversations.json` exports.
