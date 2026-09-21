export interface KVStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
  exportJSON(): string;
  importJSON(data: string): void;
  clear(): void;
}

export class MemoryKVStore implements KVStore {
  private map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return Array.from(this.map.keys()).sort();
  }

  clear(): void {
    this.map.clear();
  }

  exportJSON(): string {
    const entries: [string, string][] = Array.from(this.map.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return JSON.stringify({ version: 1, entries });
  }

  importJSON(data: string): void {
    const parsed = JSON.parse(data) as { version: number; entries: [string, string][] };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('不支持的导出格式');
    }
    this.map = new Map(parsed.entries);
  }
}

export class LocalStorageKVStore implements KVStore {
  private prefix: string;

  constructor(prefix = 'iis:') {
    this.prefix = prefix;
  }

  private available(): boolean {
    return typeof localStorage !== 'undefined';
  }

  get(key: string): string | undefined {
    if (!this.available()) {
      return undefined;
    }
    return localStorage.getItem(this.prefix + key) ?? undefined;
  }

  set(key: string, value: string): void {
    if (this.available()) {
      localStorage.setItem(this.prefix + key, value);
    }
  }

  delete(key: string): void {
    if (this.available()) {
      localStorage.removeItem(this.prefix + key);
    }
  }

  keys(): string[] {
    if (!this.available()) {
      return [];
    }
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full && full.startsWith(this.prefix)) {
        result.push(full.slice(this.prefix.length));
      }
    }
    return result.sort();
  }

  clear(): void {
    if (!this.available()) {
      return;
    }
    for (const key of this.keys()) {
      localStorage.removeItem(this.prefix + key);
    }
  }

  exportJSON(): string {
    const entries: [string, string][] = this.keys().map((key) => [
      key,
      this.get(key) ?? ''
    ]);
    return JSON.stringify({ version: 1, entries });
  }

  importJSON(data: string): void {
    const parsed = JSON.parse(data) as { version: number; entries: [string, string][] };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('不支持的导出格式');
    }
    this.clear();
    for (const [key, value] of parsed.entries) {
      this.set(key, value);
    }
  }
}
