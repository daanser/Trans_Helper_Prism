// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf D1 bigram 回退索引 (tasks.md T1.3 / plan.md §5.4)
// 回退链路：关键词检索时把 query 切成 bigram / ASCII 词 token，去 D1 bigram_index 表按 gram 匹配，
// 按 path 聚合、命中 gram 数降序取 top。全程纯 D1，零外部调用、零配额消耗（与完整向量链路解耦）。
// 本文件对应 M1 把 fallback 桩换成真实现：bigram 切分 + D1 写入 + D1 查询。
import type { SearchHit } from "./types"

/** bigram_index 表的一行（含 snippet，M1 按需补充列）。 */
export interface BigramRow {
  id: string
  wiki_id: string
  path: string
  title: string
  section: string | null
  url: string | null
  gram: string
  snippet: string | null
}

/** 一个文档在语法命中统计中的聚合形态。 */
interface AggRow {
  id: string
  wiki_id: string
  path: string
  title: string
  url: string
  snippet: string
  /** 命中的 gram 去重集合大小即命中分。 */
  matchedGrams: Set<string>
}

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

/** 写入一行到 bigram_index（供 ingest 侧调用）。返回影响行数，失败不抛出吞错由调用方决定。 */
export function writeBigramRow(db: D1Database, row: {
  id: string
  wiki_id: string
  path: string
  title: string
  section: string | null
  url: string | null
  gram: string
  snippet: string | null
  updatedAt: number
}): Promise<number> {
  return db
    .prepare(
      `INSERT OR REPLACE INTO bigram_index
        (id, wiki_id, path, title, section, url, gram, snippet, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.wiki_id, row.path, row.title, row.section, row.url, row.gram, row.snippet, row.updatedAt)
    .run()
    .then((res) => res.meta.changes ?? 0)
}

/**
 * 查询 bigram 匹配：对一组 gram 发一次 IN 查询，按 path 去重聚合，命中 gram 数降序，取 topK。
 * grams 为空直接返回 []（不发查询）。确定性：同分按 path 字典序兜底。
 */
export async function queryBigrams(db: D1Database, grams: string[], topK: number): Promise<BigramRow[]> {
  if (grams.length === 0 || topK < 1) return []
  const placeholders = grams.map((_, idx) => `?${idx + 1}`).join(", ")
  const { results } = await db
    .prepare(`SELECT id, wiki_id, path, title, section, url, gram, snippet
               FROM bigram_index
               WHERE gram IN (${placeholders})`)
    .bind(...grams)
    .all<BigramRow>()

  // 按 path 聚合，统计命中的去重 gram 集合（一条文档可能有多行）。
  const byPath = new Map<string, AggRow>()
  for (const r of results) {
    if (r.path === "") continue
    let agg = byPath.get(r.path)
    if (!agg) {
      agg = {
        id: r.id,
        wiki_id: r.wiki_id,
        path: r.path,
        title: r.title,
        url: r.url ?? "",
        snippet: r.snippet ?? "",
        matchedGrams: new Set<string>(),
      }
      byPath.set(r.path, agg)
    }
    agg.matchedGrams.add(r.gram)
  }

  return [...byPath.values()]
    .sort((a, b) => b.matchedGrams.size - a.matchedGrams.size || (a.path < b.path ? -1 : 1))
    .slice(0, topK)
    .map((r) => ({
      id: r.id,
      wiki_id: r.wiki_id,
      path: r.path,
      title: r.title,
      section: null,
      url: r.url,
      gram: "",
      snippet: r.snippet,
    }))
}

/** bigram 命中行 → SearchHit。source 用 wiki_id 充当（fallback 无 source 字段时的一致映射）。 */
export function rowToHit(r: BigramRow): SearchHit {
  return {
    id: r.id,
    title: r.title,
    url: r.url ?? "",
    source: r.wiki_id,
    path: r.path,
    snippet: r.snippet ?? "",
    score: 1,
  }
}