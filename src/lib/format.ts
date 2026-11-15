import type { ApiEvent } from '../feed.js';

export function measure(value: number | null, unit: string | null): string | null {
  if (value == null) return null;
  if (unit === 'min') return value >= 90 ? `${(value / 60).toFixed(1)}h` : `${value}m`;
  const label = value === 1 && unit?.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${value}${label ? ` ${label}` : ''}`;
}

export function formatEvent(e: ApiEvent, tz: string): string {
  const when = new Date(e.occurredAt).toLocaleString('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const showSize = !['ai_block', 'commit', 'pr'].includes(e.kind);
  const size = showSize ? measure(e.value, e.unit) : null;
  const sub = e.subtitle ? `  [${e.subtitle}]` : '';
  return `${when}  ${e.kind.padEnd(11)} ${e.title}${sub}${size ? `  ${size}` : ''}`;
}
