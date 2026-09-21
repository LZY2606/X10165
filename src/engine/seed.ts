import type { Snapshot } from "./types";

export function seedSnapshot(): Snapshot {
  return {
    docs: {
      "docs/intro.md": {
        path: "docs/intro.md",
        content: "alpha beta alpha index overview",
        parserVersion: "v1",
      },
      "docs/guide.md": {
        path: "docs/guide.md",
        content: "beta gamma delta guide index",
        parserVersion: "v1",
      },
      "docs/api.md": {
        path: "docs/api.md",
        content: "gamma alpha delta api reference",
        parserVersion: "v1",
      },
    },
    refs: {
      "r-intro-guide": {
        id: "r-intro-guide",
        from: "docs/intro.md",
        to: "docs/guide.md",
        label: "下一步阅读",
      },
      "r-guide-api": {
        id: "r-guide-api",
        from: "docs/guide.md",
        to: "docs/api.md",
        label: "API 引用",
      },
      "r-api-intro": {
        id: "r-api-intro",
        from: "docs/api.md",
        to: "docs/intro.md",
        label: "回到概览",
      },
    },
    tombstones: {},
  };
}
