// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 中文 bigram 分词（只做分词，**不再落 D1**）
//
// ── 本文件现在只提供一件事：`splitBigrams()` ──
// 把 query 切成 bigram / ASCII 词 token，供 **本地重排打分** 用：
// `src/fallback.ts` 把 query 切 token → 查 Qdrant 全文索引（payload.text，tokenizer=multilingual）
// → 在本地按"token 在正文中出现次数"排序。全程零 D1、零额外上游调用。
//
// ── 历史（别把它加回来，改前先读这段）──
// M1 曾用 D1 表 `bigram_index` 做回退检索的倒排索引（写入 + 查询 + rowToHit 三件套）。
// 实测 1481 个 chunk 会产生 **521,925 行**，而 D1 免费版每天只允许写 100,000 行（history.md §5 坑 14），
// 超 5.2 倍 → 一次全量写入根本不可能。回退检索因此改成 Qdrant 自带全文索引，
// `bigram_index` 的写入路径**只剩 ingest 在写、没有任何地方读**（纯死代码 + 占 D1 空间）。
// 2026-09-11 技术债清理：删除写入路径与表（见 schemaStatements.ts 的 `DROP TABLE IF EXISTS bigram_index`），
// **只保留 `splitBigrams`**（它仍是回退分支排序的核心逻辑，与 D1 无关）。
//
// 本文件是纯函数模块：不碰 D1 / KV / 网络 / env，可在任意环境单测。

/** 判定单字符是否属于 CJK（含扩展）区，用于成对切分。 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x2e80 && code <= 0x2eff) // CJK 部首
  )
}

/** 判定单字符是否为 ASCII 词字符（字母/数字），用于"连续 ASCII 词 token"。 */
function isAsciiWord(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
}

/**
 * 中文/混合文本的 bigram 切分（幂等、确定性）。
 * 规则：连续 CJK 字符成对产生 bigram（单 CJK 字符降级为该字本身）；连续 ASCII 词字符输出整词 token（小写）。
 * 输出去重、保持出现顺序；输入为空或无可切内容时返回 []。
 */
export function splitBigrams(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    if (t === "") return
    if (seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (isCjk(code)) {
      // 连续 CJK 段：逐字成对
      let j = i
      while (j < text.length && isCjk(text.charCodeAt(j))) j++
      const run = text.slice(i, j)
      if (run.length === 1) {
        push(run) // 单字：降级为该字本身，保证单字查询可用
      } else {
        for (let k = 0; k + 1 < run.length; k++) push(run[k] + run[k + 1])
      }
      i = j
      continue
    }
    if (isAsciiWord(code)) {
      // 连续 ASCII 词
      let j = i
      while (j < text.length && isAsciiWord(text.charCodeAt(j))) j++
      push(text.slice(i, j).toLowerCase())
      i = j
      continue
    }
    i++ // 其它字符（空白/标点）跳过
  }
  return out
}
