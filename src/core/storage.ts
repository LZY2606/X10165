import { canonicalStringify } from './hash';
import type { PersistedState } from './types';

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** In-memory store used by tests. */
export class MemoryStore implements KVStore {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** localStorage-backed store used by the web UI. */
export class LocalStorageStore implements KVStore {
  constructor(private prefix = 'iisim:') {}
  get(key: string): string | null {
    return globalThis.localStorage?.getItem(this.prefix + key) ?? null;
  }
  set(key: string, value: string): void {
    globalThis.localStorage?.setItem(this.prefix + key, value);
  }
}

export function emptyState(): PersistedState {
  return {
    currentRevision: 0,
    parserVersion: 1,
    live: {},
    signatures: {},
    revisions: [],
    plans: [],
    events: [],
    seq: 0,
  };
}

/** Persistent container for revisions, plans, execution events and live state. */
export class Store {
  data: PersistedState;

  constructor(
    private kv: KVStore,
    private key = 'state',
  ) {
    const raw = kv.get(key);
    this.data = raw ? (JSON.parse(raw) as PersistedState) : emptyState();
  }

  save(): void {
    this.kv.set(this.key, canonicalStringify(this.data));
  }

  export(): string {
    return canonicalStringify(this.data);
  }

  import(json: string): void {
    const parsed = JSON.parse(json) as PersistedState;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray(parsed.revisions) ||
      !Array.isArray(parsed.plans)
    ) {
      throw new Error('invalid export payload');
    }
    this.data = { ...emptyState(), ...parsed };
    this.save();
  }
}
