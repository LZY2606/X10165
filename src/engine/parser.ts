import type { ParserVersion } from "./types";
import { fnv1aHex } from "./hash";

export const DEFAULT_PARSER_VERSION: ParserVersion = "v1";

export function tokenize(content: string, version: ParserVersion): string[] {
  const normalized = content.toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const tokens = words.filter((word) => word.length > 0);
  if (version === "v1") {
    return tokens;
  }
  return tokens.map((token) => {
    const stem = token.length > 3 ? token.slice(0, -2) : token;
    return `${stem}~${fnv1aHex(token).slice(0, 4)}`;
  });
}

export function parserDescription(version: ParserVersion): string {
  if (version === "v1") {
    return "v1：原始小写分词";
  }
  if (version === "v2") {
    return "v2：词干归一 + 词形后缀";
  }
  return `${version}：未知版本`;
}
