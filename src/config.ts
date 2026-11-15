import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const ROOT_DIR = ROOT;
export const DATA_DIR = process.env.LIFE_DATA_DIR ?? join(ROOT, 'data');
export const INBOX_DIR = process.env.LIFE_INBOX_DIR ?? join(ROOT, 'inbox');
export const DB_PATH = process.env.LIFE_DB_PATH ?? join(DATA_DIR, 'life.db');

export const PORT = Number(process.env.LIFE_PORT ?? 7777);
export const HOST = process.env.LIFE_HOST ?? '127.0.0.1';
export const TOKEN = process.env.LIFE_TOKEN ?? '';
export const TZ = process.env.LIFE_TZ ?? 'Asia/Kolkata';

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const GITHUB_USER = process.env.GITHUB_USER ?? '';
export const GITHUB_SINCE_DAYS = Number(process.env.GITHUB_SINCE_DAYS ?? 400);

export const HOME = homedir();
export const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
export const COMMANDCODE_HISTORY = join(HOME, '.commandcode', 'history.jsonl');
