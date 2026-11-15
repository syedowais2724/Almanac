import { appleHealth } from './apple-health.js';
import { claudeCode } from './claude-code.js';
import { commandcode } from './commandcode.js';
import { github } from './github.js';
import type { LifeSource } from '../types.js';

export const sources: LifeSource[] = [github, claudeCode, commandcode, appleHealth];

export function getSource(name: string): LifeSource | undefined {
  return sources.find((s) => s.name === name);
}
