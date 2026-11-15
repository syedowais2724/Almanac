import { createReadStream, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_PROJECTS, TZ } from '../config.js';
import type { LifeEvent, LifeSource, SyncContext, SyncResult } from '../types.js';
import { writeEvents } from '../db.js';
import { localDayKey, makeId } from '../lib/util.js';

const SOURCE = 'claude-code';
const ACTIVE_GAP_MS = 30 * 60_000;

interface Accum {
  sessionId: string;
  cwd: string | null;
  first: number | null;
  last: number | null;
  turns: number;
  assistantTurns: number;
  subagentFiles: number;
  tokens: number;
  cacheTokens: number;
  activeMs: number;
  subagentActiveMs: number;
  models: Set<string>;
}

interface Found {
  file: string;
  key: string;
  mtimeMs: number;
}

function textOf(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
      }
    }
  }
  return null;
}

function isToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool_result',
  );
}

function projectLabel(dir: string): string {
  const pieces = basename(dir).split('-').filter(Boolean);
  return pieces.at(-1) ?? basename(dir);
}

function sessionKeyOf(file: string): string {
  const parts = relative(CLAUDE_PROJECTS, file).split(sep);
  if (parts.length >= 4 && parts.at(-2) === 'subagents') return parts.at(-3) ?? basename(file, '.jsonl');
  return basename(file, '.jsonl');
}

async function readFileInto(acc: Accum, file: string): Promise<void> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const isSubagent = file.includes(`${sep}subagents${sep}`);
  let lastTs: number | null = null;
  let fileActiveMs = 0;

  for await (const line of rl) {
    if (!line.startsWith('{')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!acc.cwd && typeof rec.cwd === 'string') acc.cwd = rec.cwd;
    if (typeof rec.timestamp === 'string') {
      const at = Date.parse(rec.timestamp);
      if (Number.isFinite(at)) {
        if (acc.first === null || at < acc.first) acc.first = at;
        if (acc.last === null || at > acc.last) acc.last = at;
        if (lastTs !== null && at - lastTs > 0 && at - lastTs <= ACTIVE_GAP_MS) {
          fileActiveMs += at - lastTs;
        }
        lastTs = at;
      }
    }

    const msg = rec.message as
      | { usage?: Record<string, number>; model?: string }
      | undefined;

    if (rec.type === 'user' && !isToolResult(rec.message) && textOf(rec.message)) {
      acc.turns++;
    } else if (rec.type === 'assistant' && msg) {
      acc.assistantTurns++;
      if (msg.model) acc.models.add(msg.model);
      const u = msg.usage;
      if (u) {
        acc.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        acc.cacheTokens +=
          (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
  }

  if (isSubagent) acc.subagentActiveMs += fileActiveMs;
  else acc.activeMs += fileActiveMs;
}

export const claudeCode: LifeSource = {
  name: SOURCE,
  label: 'Claude Code sessions',
  enabled: () => true,

  async sync(ctx: SyncContext): Promise<SyncResult> {
    let found: Found[] = [];
    try {
      found = readdirSync(CLAUDE_PROJECTS, { recursive: true, encoding: 'utf8' })
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => join(CLAUDE_PROJECTS, f))
        .map((file: string) => {
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(file).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          return { file, key: sessionKeyOf(file), mtimeMs };
        });
    } catch {
      return { scanned: 0, written: 0, skipped: `no transcripts at ${CLAUDE_PROJECTS}` };
    }

    const sinceMs = ctx.since ? Date.parse(ctx.since) : 0;
    const touched = new Set(found.filter((f) => f.mtimeMs > sinceMs).map((f) => f.key));
    if (touched.size === 0) return { scanned: 0, written: 0 };

    const accs = new Map<string, Accum>();
    let scanned = 0;

    for (const item of found) {
      if (!touched.has(item.key)) continue;
      scanned++;

      let acc = accs.get(item.key);
      if (!acc) {
        acc = {
          sessionId: item.key,
          cwd: null,
          first: null,
          last: null,
          turns: 0,
          assistantTurns: 0,
          subagentFiles: 0,
          tokens: 0,
          cacheTokens: 0,
          activeMs: 0,
          subagentActiveMs: 0,
          models: new Set(),
        };
        accs.set(item.key, acc);
      }
      if (item.file.includes(`${sep}subagents${sep}`)) acc.subagentFiles++;

      await readFileInto(acc, item.file);
    }

    const events: LifeEvent[] = [];

    for (const acc of accs.values()) {
      if (acc.first === null || acc.turns === 0) continue;

      const startMs = acc.first;
      const endMs = acc.last ?? acc.first;
      const activeMs = acc.activeMs || acc.subagentActiveMs;
      const minutes = Math.max(1, Math.round(activeMs / 60_000));
      const spanMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
      const project = acc.cwd ? basename(acc.cwd) : projectLabel(join(CLAUDE_PROJECTS, acc.sessionId));

      const bits = [
        `${acc.turns} turn${acc.turns === 1 ? '' : 's'}`,
        `${acc.tokens.toLocaleString('en-US')} tokens`,
      ];
      if (acc.cacheTokens) bits.push(`${(acc.cacheTokens / 1_000_000).toFixed(1)}M cached`);
      if (acc.subagentFiles) bits.push(`${acc.subagentFiles} subagents`);

      events.push({
        id: makeId(SOURCE, acc.sessionId),
        source: SOURCE,
        kind: 'ai_session',
        occurredAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        title: `Claude Code · ${project}`,
        subtitle: bits.join(' · '),
        value: minutes,
        unit: 'min',
        meta: {
          tool: 'claude-code',
          project,
          sessionId: acc.sessionId,
          turns: acc.turns,
          assistantTurns: acc.assistantTurns,
          tokens: acc.tokens,
          cacheTokens: acc.cacheTokens,
          subagentFiles: acc.subagentFiles,
          activeMinutes: minutes,
          spanMinutes,
          models: [...acc.models],
          day: localDayKey(new Date(startMs), TZ),
        },
      });
    }

    const written = writeEvents(events);
    return { scanned, written };
  },
};
