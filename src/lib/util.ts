import { createHash } from 'node:crypto';

export const makeId = (...parts: string[]) =>
  createHash('sha1').update(parts.join(':')).digest('hex');

const partsFmt = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, tz: string): Record<string, string> {
  let fmt = partsFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFmt.set(tz, fmt);
  }
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

export function tzOffsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

export function localDayKey(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHourKey(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}

export function localToIso(
  y: number,
  m: number,
  d: number,
  h: number,
  tz: string,
): string {
  const guess = Date.UTC(y, m - 1, d, h);
  const off1 = tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(guess - off1), tz);
  return new Date(guess - off2).toISOString();
}

export function offsetModifier(tz: string): string {
  const minutes = Math.round(tzOffsetMs(new Date(), tz) / 60_000);
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${Math.abs(minutes)} minutes`;
}

export function hourKeyToIso(hourKey: string, tz: string): string {
  const [datePart, hour] = hourKey.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  return localToIso(y, m, d, Number(hour), tz);
}

export function dayRange(day: string, tz: string): { start: string; end: string } {
  const [y, m, d] = day.split('-').map(Number);
  return { start: localToIso(y, m, d, 0, tz), end: localToIso(y, m, d + 1, 0, tz) };
}

const SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function safeText(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (SECRET.test(flat)) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
