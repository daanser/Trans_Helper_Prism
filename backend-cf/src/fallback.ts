// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 关键词回退分支 (plan.md §5.4 / tasks.md T1.3)
// 嵌入/上游失败（池全灭/超时/5xx）时自动降级到本分支：直接查 Qdrant 的**全文索引**（payload.text）。
//
// 为什么不用 D1 bigram 索引（原设计）：实测现有 1481 个 chunk 会产生 **521,925 行**，
// 而 D1 免费版每天只允许写 100,000 行（官方 pricing 文档）——超 5.2 倍，一次全量写入根本不可能，
// 且每次重嵌都要重写。改用 Qdrant 自带 text 索引（tokenizer=multilingual，中文分词可用）：
// 零 D1 行、单次请求、无额外表，且与向量检索共用同一个 Qdrant。
//
// 索引需先创建（ingest 脚本会幂等创建）：
//   PUT /collections/{c}/index  {"field_name":"text","field_schema":{"type":"text","tokenizer":"multilingual"}}
//
// 特点：零 embedding、零配额消耗、返回 fallback:true，前端展示 banner。
import type { SearchHit } from "./types"
import { splitBigrams } from "./bigram"
import { collectionName } from "./wiki_registry"

/** 回退分支响应体。与完整调用的 SearchResponse 形状不同（无 timings/quota）。 */
export interface FallbackResponse {
  hits: SearchHit[]
  fallback: true
  notice: string
}

/** 回退检索默认返回条数。 */
const DEFAULT_TOP_K = 10
/** 每个库最多取多少条候选（本地再按命中度排序）。 */
const PER_CORPUS_LIMIT = 40

/** 回退检索所需的 env 子集。 */
export interface FallbackEnv {
  QDRANT_URL?: string
  QDRANT_API_KEY?: string
}

interface ScrollPoint {
  id?: string | number
  payload?: Record<string, unknown> | null
}

/** 本地打分：query 的 token 在正文中出现的次数之和（越高越相关）。 */
function scoreText(text: string, tokens: readonly string[]): number {
  if (!text || tokens.length === 0) return 0
  const lower = text.toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (!t) continue
    const needle = t.toLowerCase()
    let idx = lower.indexOf(needle)
    while (idx !== -1) {
      score++
      idx = lower.indexOf(needle, idx + needle.length)
    }
  }
  return score
}

/**
 * 关键词回退真实现：查 Qdrant 全文索引。
 * - Qdrant 未配置 / query 为空 → 空 hits + notice（绝不抛错）。
 * - 单库失败不影响其它库。
 */
export async function runFallback(
  query: string,
  corpora: readonly string[],
  env: FallbackEnv,
  opts: { fetchImpl?: typeof fetch; topK?: number } = {},
): Promise<FallbackResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const topK = opts.topK ?? DEFAULT_TOP_K
  const q = (query ?? "").trim()

  if (!q) {
    return { hits: [], fallback: true, notice: "关键词模式（查询为空）" }
  }
  if (!env.QDRANT_URL) {
    return { hits: [], fallback: true, notice: "关键词模式（Qdrant 未配置，无法检索）" }
  }

  const tokens = splitBigrams(q)
  if (tokens.length === 0) {
    return { hits: [], fallback: true, notice: "关键词模式（无可匹配词）" }
  }

  const base = env.QDRANT_URL.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (env.QDRANT_API_KEY) headers["api-key"] = env.QDRANT_API_KEY

  const candidates: Array<{ hit: SearchHit; score: number }> = []

  for (const corpus of corpora) {
    try {
      const resp = await fetchImpl(`${base}/collections/${collectionName(corpus)}/points/scroll`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          limit: PER_CORPUS_LIMIT,
          with_payload: true,
          with_vector: false,
          filter: { must: [{ key: "text", match: { text: q } }] },
        }),
      })
      if (!resp.ok) continue
      const j = (await resp.json()) as { result?: { points?: ScrollPoint[] } }
      for (const p of j.result?.points ?? []) {
        const payload = (p.payload ?? {}) as Record<string, unknown>
        const s = (v: unknown): string => (typeof v === "string" ? v : "")
        const text = s(payload.text) || s(payload.snippet)
        const path = s(payload.path)
        if (!path) continue
        candidates.push({
          score: scoreText(text, tokens),
          hit: {
            id: String(p.id ?? ""),
            title: s(payload.title) || corpus,
            url: s(payload.url),
            source: s(payload.wiki_id) || corpus,
            path,
            snippet: text,
            score: 1,
          },
        })
      }
    } catch {
      // 单库异常不影响其它库
      continue
    }
  }

  // 同一文档（wiki + path）多 chunk 命中：取最高分的那条。
  const byPath = new Map<string, { hit: SearchHit; score: number }>()
  for (const c of candidates) {
    const key = `${c.hit.source}::${c.hit.path}`
    const prev = byPath.get(key)
    if (!prev || c.score > prev.score) byPath.set(key, c)
  }

  const hits = [...byPath.values()]
    .sort((a, b) => b.score - a.score || (a.hit.path < b.hit.path ? -1 : 1))
    .slice(0, topK)
    .map((c) => ({ ...c.hit, score: c.score }))

  return { hits, fallback: true, notice: "关键词模式（Qdrant 全文索引）" }
}
