import { GITHUB_SINCE_DAYS, GITHUB_TOKEN, GITHUB_USER } from '../config.js';
import type { LifeEvent, LifeSource, SyncContext, SyncResult } from '../types.js';
import { writeEvents } from '../db.js';
import { makeId, safeText, shortSha } from '../lib/util.js';

const SOURCE = 'github';
const API = 'https://api.github.com';

interface Repo {
  full_name: string;
  pushed_at: string | null;
  fork: boolean;
  archived: boolean;
}

interface Commit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { date: string } | null };
}

interface SearchItem {
  id: number;
  title: string;
  html_url: string;
  created_at: string;
  pull_request?: unknown;
}

async function gh<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GITHUB_TOKEN}`,
      'user-agent': 'almanac',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`github ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function commitsFor(repo: string, since: string, user: string): Promise<Commit[]> {
  const out: Commit[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh<Commit[]>(`/repos/${repo}/commits`, {
      author: user,
      since,
      per_page: 100,
      page,
    });
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const MERGE_COMMIT = /^Merge (pull request|branch|remote-tracking)/;

export const github: LifeSource = {
  name: SOURCE,
  label: 'GitHub commits and pull requests',
  enabled: () => Boolean(GITHUB_TOKEN && GITHUB_USER),

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!GITHUB_TOKEN || !GITHUB_USER) {
      return { scanned: 0, written: 0, skipped: 'set GITHUB_TOKEN and GITHUB_USER in .env' };
    }

    const since =
      ctx.since ?? new Date(Date.now() - GITHUB_SINCE_DAYS * 86_400_000).toISOString();
    const events: LifeEvent[] = [];
    let scanned = 0;

    const repos: Repo[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await gh<Repo[]>('/user/repos', {
        per_page: 100,
        page,
        sort: 'pushed',
        direction: 'desc',
        affiliation: 'owner,collaborator,organization_member',
      });
      repos.push(...batch);
      if (batch.length < 100) break;
    }

    const active = repos
      .filter((r) => !r.fork && !r.archived)
      .filter((r) => !r.pushed_at || r.pushed_at >= since);

    ctx.log(`${active.length} active repos of ${repos.length}`);

    for (const repo of active) {
      let commits: Commit[] = [];
      try {
        commits = await commitsFor(repo.full_name, since, GITHUB_USER);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('409') || message.includes('404')) continue;
        ctx.log(`skip ${repo.full_name}: ${message.slice(0, 120)}`);
        continue;
      }
      scanned += commits.length;

      for (const c of commits) {
        const date = c.commit.author?.date;
        if (!date) continue;
        const firstLine = c.commit.message.split('\n')[0] ?? '';
        if (MERGE_COMMIT.test(firstLine)) continue;
        events.push({
          id: makeId(SOURCE, 'commit', c.sha),
          source: SOURCE,
          kind: 'commit',
          occurredAt: new Date(date).toISOString(),
          title: safeText(firstLine, 100) || shortSha(c.sha),
          subtitle: repo.full_name,
          value: 1,
          unit: 'commit',
          meta: { repo: repo.full_name, sha: c.sha, url: c.html_url },
        });
      }
    }

    const sinceDay = since.slice(0, 10);
    try {
      for (let page = 1; page <= 3; page++) {
        const prs = await gh<{ items: SearchItem[] }>('/search/issues', {
          q: `author:${GITHUB_USER} type:pr created:>${sinceDay}`,
          sort: 'created',
          order: 'desc',
          per_page: 100,
          page,
        });
        scanned += prs.items.length;
        for (const pr of prs.items) {
          events.push({
            id: makeId(SOURCE, 'pr', String(pr.id)),
            source: SOURCE,
            kind: 'pr',
            occurredAt: new Date(pr.created_at).toISOString(),
            title: safeText(pr.title, 100) || 'pull request',
            subtitle: 'opened a pull request',
            value: 1,
            unit: 'pr',
            meta: { url: pr.html_url },
          });
        }
        if (prs.items.length < 100) break;
      }
    } catch (err) {
      ctx.log(`search failed: ${(err as Error).message.slice(0, 160)}`);
    }

    const written = writeEvents(events);
    return { scanned, written };
  },
};
