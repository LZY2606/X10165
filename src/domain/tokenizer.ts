// 解析器：不同版本产生不同 token，用于演示“解析器版本依赖”

export function tokenize(content: string, parserVersion: number): string[] {
  const CJK = /[\u4e00-\u9fa5]/u;
  const raw = content
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .filter(Boolean);
  if (parserVersion <= 1) {
    return raw;
  }
  // v2+：中文按字符拆分，英文保持词组
  const out: string[] = [];
  for (const token of raw) {
    if (CJK.test(token) && token.length > 1) {
      for (const ch of token) out.push(ch);
    } else {
      out.push(token);
    }
  }
  if (parserVersion >= 3) {
    // v3+：附带 bigram
    const grams: string[] = [];
    for (let i = 0; i < out.length - 1; i++) grams.push(`${out[i]}_${out[i + 1]}`);
    out.push(...grams);
  }
  return out;
}
