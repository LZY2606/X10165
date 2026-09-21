// 本地 KV 存储抽象。浏览器使用 localStorage，测试使用内存实现。
import type { StoreDump } from './types';

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
  export(): StoreDump;
  load(dump: StoreDump): void;
}

const FORMAT = 'incremental-index-simulator/v1';

export class MemoryStore implements KVStore {
  private map: Map<string, string>;

  constructor(initial?: Record<string, string>) {
    this.map = new Map(Object.entries(initial ?? {}));
  }

  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }

  export(): StoreDump {
    const entries: Record<string, string> = {};
    for (const [k, v] of this.map) entries[k] = v;
    return { format: FORMAT, exportedAt: Date.now(), entries };
  }

  load(dump: StoreDump): void {
    if (dump.format !== FORMAT) throw new Error(`不支持的导出格式: ${dump.format}`);
    this.map = new Map(Object.entries(dump.entries ?? {}));
  }
}

export class LocalStorageStore implements KVStore {
  private prefix: string;

  constructor(prefix = 'iis.v1.') {
    this.prefix = prefix;
  }

  private storage(): Storage {
    if (typeof localStorage === 'undefined') throw new Error('当前环境不支持 localStorage');
    return localStorage;
  }

  get(key: string): string | null {
    return this.storage().getItem(this.prefix + key);
  }

  set(key: string, value: string): void {
    this.storage().setItem(this.prefix + key, value);
  }

  delete(key: string): void {
    this.storage().removeItem(this.prefix + key);
  }

  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.storage().length; i++) {
      const full = this.storage().key(i);
      if (full && full.startsWith(this.prefix)) out.push(full.slice(this.prefix.length));
    }
    return out.sort();
  }

  export(): StoreDump {
    const entries: Record<string, string> = {};
    for (const k of this.keys()) entries[k] = this.get(k) as string;
    return { format: FORMAT, exportedAt: Date.now(), entries };
  }

  load(dump: StoreDump): void {
    if (dump.format !== FORMAT) throw new Error(`不支持的导出格式: ${dump.format}`);
    const s = this.storage();
    for (const k of this.keys()) s.removeItem(this.prefix + k);
    for (const [k, v] of Object.entries(dump.entries ?? {})) s.setItem(this.prefix + k, v);
  }
}
