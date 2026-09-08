// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 纯向量检索编排 (tasks.md T0.4 / plan.md §5.1)
// 链路：校验 → embedding(query) → Qdrant 多 collection 并行检索 → 合并去重 → 截断 top_k。
// rerank/LLM 为可选开关：M0 下 use_reranker/use_llm 只打 warnings 仍返回纯向量结果。
// embedding 上游失败（池全灭/超时/5xx）自动切 fallback（T1.3：D1 bigram 真实现，见 bigram.ts）。
// 所有 key/URL 只来自 env secrets/vars，绝不硬编码。
import type { Env, SearchRequest, SearchResponse, SearchHit } from "./types"
import { createEmbeddingProvider, defaultFetch } from "./embeddings"
import { createRerankProvider } from "./rerank"
import { runFallback, FallbackResponse } from "./fallback"
import { kvCache, buildCacheKey, cacheGetVectorStage, cachePutVectorStage, type CacheStore } from "./searchcache"
import type { KeyPoolDb } from "./keypool"

/** M0 四个库的 corpora 白名单（tasks.md T0.4）。 */
export const VALID_CORPORA = ["mtf-wiki", "ftm-wiki", "rle-wiki", "miomtfwiki"] as const
export type CorpusId = (typeof VALID_CORPORA)[number]

/** 参数非法。路由捕获后返回 422（plan.md §3.3）。 */
export class SearchValidationError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** 单次搜索的可注入依赖（测试时 mock fetch/db/时钟/缓存，绝不调真实上游）。 */
export interface RunSearchOpts {
  db?: KeyPoolDb
  fetchImpl?: typeof fetch
  nowMs?: () => number
  /** 结果缓存（KVNamespace 或测试内存实现）。注入后优先于 env.SEARCH_CACHE。 */
  cache?: CacheStore
}

export type RunSearchResult = SearchResponse | FallbackResponse

/** corpora id（如 mtf-wiki）→ Qdrant collection 名（如 mtf_wiki_v1）。 */
export function collectionName(corpus: string): string {
  return `${corpus.replace(/-/g, "_")}_v1`
}

/** Qdrant /points/search 返回的单条 point。 */
interface QdrantPoint {
  id: string | number
  score: number
  payload?: Record<string, unknown> | null
}

/** 单 collection 检索结果映射为 booru SearchHit。source 优先取 payload 里的 wiki 名，否则用 corpora id。 */
function toHit(p: QdrantPoint, corpus: CorpusId): SearchHit {
  const payload = (p.payload ?? {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === "string" ? v : "")
  return {
    id: String(p.id),
    title: s(payload.title) || corpus,
    url: s(payload.url),
    source: s(payload.source) || s(payload.wiki_id) || corpus,
    path: s(payload.path) || s(payload.section_path) || "",
    snippet: s(payload.snippet) || s(payload.text) || s(payload.content),
    score: p.score,
  }
}

/** 一个 collection 的 Qdrant 检索失败（含"库不存在"与超时）。携带状态码便于 caller 分类打 warning。 */
export class QdrantSearchError extends Error {
  readonly status: number // 404=库不存在；0=超时/网络
  readonly collection: string
  constructor(collection: string, status: number, detail: string) {
    super(`qdrant-search-failed collection=${collection} status=${status} ${detail}`)
    this.collection = collection
    this.status = status
  }
}

/** 解析超时毫秒配置（env 覆盖，默认 15s）。非法值回退默认。 */
export function parseTimeoutMs(raw: string | undefined, fallback = 15_000): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = parseInt(raw, 10)
  if (Number.isFinite(n) && n > 0) return n
  return fallback
}

/** 对一个 collection 发起 Qdrant REST 检索（fetch REST，不装客户端）。超时/非 2xx 抛 QdrantSearchError。 */
async function searchCollection(
  collection: string,
  vector: number[],
  limit: number,
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<QdrantPoint[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let resp: Response
  try {
    resp = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/collections/${collection}/points/search`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
      }),
    })
  } catch (e) {
    // 超时（abort）或网络错误
    const aborted = (e as Error)?.name === "AbortError"
    throw new QdrantSearchError(collection, 0, aborted ? "timeout" : `network:${(e as Error)?.message ?? ""}`)
  } finally {
    clearTimeout(timer)
  }
  if (!resp.ok) {
    // 单库失败不影响其它库；错误由 caller 分类打 warning（history §5 坑 5：库不存在别再静默吞）。
    throw new QdrantSearchError(collection, resp.status, "")
  }
  const data = (await resp.json()) as { result: QdrantPoint[] }
  return data.result
}

/** 参数校验。非法抛 SearchValidationError，路由映射为 422。 */
export function validate(req: SearchRequest): { corpora: CorpusId[]; topK: number } {
  if (typeof req.query !== "string" || req.query.trim() === "") {
    throw new SearchValidationError("invalid-query")
  }
  if (!Array.isArray(req.corpora) || req.corpora.length === 0) {
    throw new SearchValidationError("invalid-corpora")
  }
  const corpora = req.corpora as CorpusId[]
  for (const c of corpora) {
    if (!VALID_CORPORA.includes(c)) {
      throw new SearchValidationError("invalid-corpora")
    }
  }
  const topK = req.top_k ?? 10
  if (!Number.isInteger(topK) || topK < 1 || topK > 30) {
    throw new SearchValidationError("invalid-top-k")
  }
  return { corpora, topK }
}

/**
 * 给 rerank 的候选集上限（tasks.md T1.1：删旧魔法数字，做成配置项）。
 * 默认取 top_k*3（与单库检索 limit 一致），可用 env.RERANK_TOP_K 覆盖。
 */
export function rerankCandidateLimit(env: Env, topK: number): number {
  const cfg = env.RERANK_TOP_K
  if (cfg !== undefined && cfg.trim() !== "") {
    const n = parseInt(cfg, 10)
    if (Number.isFinite(n) && n >= 1) return n
  }
  return topK * 3
}

/** 单条 hit 供 rerank 的正文：标题 + 摘要（truncate 由 rerank 内部再做一次）。 */
function rerankDocText(hit: SearchHit): string {
  return `${hit.title}\n${hit.snippet}`
}

/** 无 D1 时的记账空实现（M0 不依赖 D1；T3.2 再接真配额/记账）。 */
const noopDb: KeyPoolDb = { async recordUsage() {} }

/** fallback 桩包成完整 SearchResponse：timings 归零、quota.fallback=true、追加降级原因 warning。 */
function toSearchResponse(
  fb: FallbackResponse,
  quota: { used_h: number; remaining_h: number; fallback: boolean },
  warnings: string[],
  reason: string,
): RunSearchResult {
  return {
    hits: fb.hits,
    timings: { embed_ms: 0, search_ms: 0, rerank_ms: 0, llm_ms: 0, total_ms: 0 },
    quota: { ...quota, fallback: true },
    warnings: [...warnings, reason],
    fallback: fb.fallback,
    notice: fb.notice,
  };
}

/**
 * 搜索入口。embedding 抛错 → 自动切 fallback（fallback:true）。
 * Qdrant URL 未配置视为上游失败 → 同样 fallback。
 * T1.2：纯向量阶段结果缓存（query+corpora+top_k），命中跳过 embed+Qdrant，rerank 仍重算。
 */
export async function runSearch(
  req: SearchRequest,
  env: Env,
  opts: RunSearchOpts = {},
): Promise<RunSearchResult> {
  const { corpora, topK } = validate(req)
  const nowMs = opts.nowMs ?? Date.now
  const fetchImpl = opts.fetchImpl ?? defaultFetch
  // 缓存：优先 opts.cache（测试注入），否则包装 env.SEARCH_CACHE；都没有就不缓存。
  const cache: CacheStore | undefined =
    opts.cache ?? (env.SEARCH_CACHE ? kvCache(env.SEARCH_CACHE) : undefined)
  const cacheKey = buildCacheKey(req.query, corpora, topK)

  const warnings: string[] = []
  if (req.use_llm) warnings.push("llm-not-yet")

  // 配额占位（T3.2 再接真计量）；fallback 标记由下方成功/降级路径覆盖。
  const quota = { used_h: 0, remaining_h: 0, fallback: false }

  // ── 纯向量阶段：命中缓存 → 直接用缓存的 hit 列表 + searchMs；未命中 → embed+Qdrant 现算。
  let embedMs = 0
  let searchMs = 0
  let merged: SearchHit[]
  let cachedHit = false
  const cached = await cacheGetVectorStage(cache, cacheKey)
  if (cached) {
    // 命中：跳过 embed/Qdrant，直接取向量初排结果（rerank 后续仍重算）。
    cachedHit = true
    merged = cached.hits
    searchMs = cached.searchMs
  } else {
    // ── embedding(query)，走 embed_pool；失败 → fallback ──
    let vector: number[]
    try {
      const { provider } = createEmbeddingProvider(env, opts.db ?? noopDb, fetchImpl)
      const t0 = nowMs()
      vector = await provider.embed(req.query.trim(), { kind: "query" })
      embedMs = nowMs() - t0
    } catch {
      return toSearchResponse(await runFallback(req.query, env.DB), quota, warnings, "embedding-unavailable")
    }

    const qdrantUrl = env.QDRANT_URL
    if (!qdrantUrl) {
      // Qdrant 未配置：视为上游失败 → 回退
      return toSearchResponse(await runFallback(req.query, env.DB), quota, warnings, "qdrant-unconfigured")
    }

    // ── 多 collection 并行检索，limit 取 top_k*3 给 rerank 留 candidate。
    // 单库失败（含库不存在/超时/网络）不影响其它库，但必须打 warning（history §5 坑 5）。 ──
    const qdrantTimeout = parseTimeoutMs(env.QDRANT_TIMEOUT_MS)
    const t1 = nowMs()
    const perCollectionLimit = topK * 3
    const results = await Promise.all(
      corpora.map(async (corpus) => {
        try {
          return await searchCollection(
            collectionName(corpus),
            vector,
            perCollectionLimit,
            fetchImpl,
            qdrantUrl,
            env.QDRANT_API_KEY,
            qdrantTimeout,
          )
        } catch (e) {
          const collection = collectionName(corpus)
          if (e instanceof QdrantSearchError) {
            // 分类：404=库不存在；0=超时/网络；其它=上游 4xx/5xx。明确打 warning，不再静默吞。
            const why =
              e.status === 404
                ? "collection-missing"
                : e.status === 0
                  ? "qdrant-unreachable"
                  : `qdrant-status-${e.status}`
            warnings.push(`collection-unavailable:${collection}:${why}`)
          } else {
            warnings.push(`collection-unavailable:${collection}:unknown-error`)
          }
          return [] as QdrantPoint[]
        }
      }),
    )

    // ── 合并去重（按 point id）→ 按 score 降序，得到向量初排 ──
    const byId = new Map<string, SearchHit>()
    for (let i = 0; i < results.length; i++) {
      const corpus = corpora[i]
      for (const p of results[i]) {
        const hit = toHit(p, corpus)
        const existing = byId.get(hit.id)
        if (!existing || hit.score > existing.score) byId.set(hit.id, hit)
      }
    }
    merged = [...byId.values()].sort((a, b) => b.score - a.score)
    searchMs = nowMs() - t1

    // 所有库都失败且无任何命中 → 视为上游全灭，整体降级回退（tasks.md T1.3 上游失败触发）。
    if (merged.length === 0 && corpora.every((c) => warnings.some((w) => w.startsWith(`collection-unavailable:${collectionName(c)}:`)))) {
      return toSearchResponse(await runFallback(req.query, env.DB), quota, warnings, "all-collections-unavailable")
    }

    // 只缓存纯向量阶段结果（rerank 每次重算，不入缓存）。写失败不影响结果。
    await cachePutVectorStage(cache, cacheKey, { hits: merged, searchMs })
  }

  // ── 可选 rerank：候选裁剪 → 批量重排 → 重排分降序 → 截断 top_k。
  // use_reranker 默认开（T1.4 压测终定：首条相关率 +10pp，P50 仍在目标内），false 才物理跳过；
  // rerank 上游失败（超时/池全灭）降级回向量序并打 warning（§5.2 第 5/7 条）。 ──
  let rerankMs = 0
  let finalHits: SearchHit[] = merged
  if (req.use_reranker !== false) {
    const candidateCount = Math.min(rerankCandidateLimit(env, topK), merged.length)
    if (candidateCount > 0) {
      const candidates = merged.slice(0, candidateCount)
      const docs = candidates.map(rerankDocText)
      let rerankScores: number[]
      try {
        const { provider } = createRerankProvider(env, opts.db ?? noopDb, fetchImpl)
        const t2 = nowMs()
        rerankScores = await provider.rerank(req.query.trim(), docs, {
          timeoutMs: parseTimeoutMs(env.RERANK_TIMEOUT_MS), // T1.3 超时配置项
        })
        rerankMs = nowMs() - t2
      } catch {
        // rerank 不可用（池全灭/超时/5xx）：保持向量序，明确打 warning，不影响整体可用性。
        warnings.push("rerank-fallback")
        rerankScores = candidates.map((h) => h.score)
      }
      finalHits = candidates
        .map((h, i) => ({ ...h, rerank_score: rerankScores[i] }))
        .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
    }
  }

  return {
    hits: finalHits.slice(0, topK),
    timings: {
      embed_ms: embedMs,
      search_ms: searchMs,
      rerank_ms: rerankMs,
      llm_ms: 0,
      total_ms: embedMs + searchMs + rerankMs,
      ...(cachedHit ? { cached: true } : {}),
    },
    quota,
    warnings,
  }
}
