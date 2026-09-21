/** Deterministic FNV-1a 32-bit hash, hex encoded. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Hash a list of parts (strings used as-is, others JSON-stringified). */
export function hashParts(...parts: unknown[]): string {
  return fnv1a(
    parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(''),
  );
}

/** Sorted-unique string list. */
export function uniqSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

/** Tokenize document content with the given parser version.
 *  v1: whitespace-separated tokens. v2: alphanumeric runs (splits punctuation). */
export function tokenize(content: string, parserVersion: number): string[] {
  const re = parserVersion >= 2 ? /[A-Za-z0-9]+/g : /\S+/g;
  return uniqSorted(content.match(re) ?? []);
}

/** Canonical JSON stringify with sorted object keys (deterministic export). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = (v as Record<string, unknown>)[k];
      }
      return out;
    }
    return v;
  });
}
