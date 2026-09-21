import type { PersistedState } from './types';

export interface Store {
  load(): PersistedState | null;
  save(state: PersistedState): void;
}

export class MemoryStore implements Store {
  private data: string | null = null;
  load(): PersistedState | null {
    return this.data ? (JSON.parse(this.data) as PersistedState) : null;
  }
  save(state: PersistedState): void {
    this.data = JSON.stringify(state);
  }
}

export class LocalStore implements Store {
  constructor(private key: string) {}
  load(): PersistedState | null {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      return raw ? (JSON.parse(raw) as PersistedState) : null;
    } catch {
      return null;
    }
  }
  save(state: PersistedState): void {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(state));
    } catch {
      // storage unavailable; ignore
    }
  }
}
