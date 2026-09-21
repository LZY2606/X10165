export interface PersistenceAdapter {
  load(): string | null;
  save(serialized: string): void;
  clear(): void;
}

export class MemoryPersistence implements PersistenceAdapter {
  private state: string | null = null;
  private failNextSave = false;

  load(): string | null {
    return this.state;
  }

  save(serialized: string): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("模拟崩溃：阶段保存失败");
    }
    this.state = serialized;
  }

  crashBeforePhase(): void {
    this.failNextSave = true;
  }

  clear(): void {
    this.state = null;
  }
}

const STORAGE_KEY = "iisim-state-v1";

export class LocalStoragePersistence implements PersistenceAdapter {
  load(): string | null {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  save(serialized: string): void {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  }

  clear(): void {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export const STORAGE_VERSION_KEY = STORAGE_KEY;
