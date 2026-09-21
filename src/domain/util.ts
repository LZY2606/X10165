// 确定性哈希、排序等工具

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stableHash(parts: (string | number | boolean | null | undefined)[]): string {
  return fnv1a(parts.map((p) => String(p)).join('\u0001'));
}

export function sortedValues<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
