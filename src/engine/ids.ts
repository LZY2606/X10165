import { fnv1aHex } from "./hash";

export const VIEWS = {
  tokenIndex: "view:token-index",
  tokenFingerprint: "view:token-fingerprint",
  refGraph: "view:ref-graph",
  rank: "view:rank",
} as const;

export function docId(path: string): string {
  return `doc:${path}`;
}

export function tombstoneId(path: string): string {
  return `tomb:${path}`;
}

export function tokenId(contentHash: string, parserVersion: string): string {
  return `token:${parserVersion}:${contentHash}`;
}

export function refId(refKey: string): string {
  return `ref:${refKey}`;
}

export function rankId(path: string): string {
  return `rank:${path}`;
}

export function contentHashKey(content: string, parserVersion: string): string {
  return fnv1aHex(`${parserVersion}\n${content}`);
}
