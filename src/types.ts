export interface LifeEvent {
  id: string;
  source: string;
  kind: string;
  occurredAt: string;
  endedAt?: string | null;
  title: string;
  subtitle?: string | null;
  value?: number | null;
  unit?: string | null;
  meta?: Record<string, unknown>;
}

export interface SyncContext {
  since: string | null;
  log: (msg: string) => void;
}

export interface SyncResult {
  scanned: number;
  written: number;
  skipped?: string;
}

export interface LifeSource {
  name: string;
  label: string;
  enabled: () => boolean;
  sync: (ctx: SyncContext) => Promise<SyncResult>;
}
