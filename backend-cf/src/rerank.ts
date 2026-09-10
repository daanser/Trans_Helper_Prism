// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf RerankProvider (plan.md §5.2 / tasks.md T1.1)
// 供应商锁定：硅基流动中国站 rerank API（bge-reranker-v2-m3）。抽象为接口保留切换能力（§8.5 逃生通道）。
// 关键设计：
//   - 走 Key Pool 的 llm_pool（rerank 与 LLM 共用一批号，§2 决策），用量记账 endpoint="rerank"；
//   - 批量推理：一次 HTTP 塞多对 (query, document)，禁止逐条循环（Workers→国内往返贵，§5.2 第 2 条）；
//   - rerankTopK 做成配置项（删旧魔法数字，§5.2 第 3 条）；
//   - 401/403/429/余额不足/超时自动换 key 重试一次（复用 withKeyRetry）；池全灭/超时抛错给上层降级为向量序。
import { KeyPool, withKeyRetry, PoolKey, type KeyPoolDb, type KeyPoolOptions } from "./keypool"
import { defaultFetch } from "./embeddings"

/** 批量 rerank 的配置（批量大小/超时，均可配）。 */
export interface RerankBatchOptions {
  /** 一次 HTTP 塞入的最大 (query,doc) 对数。默认 32。 */
  batchSize?: number
  /** 单次上游调用的硬超时毫秒。默认 15_000（与 embedding 对齐，T1.3 统一为配置项）。 */
  timeoutMs?: number
}

/** Rerank 提供方的最小契约。换供应商只换实现，不动链路。 */
export interface RerankProvider {
  /** 对 (query, docs) 批量打 relevance score，返回与 docs 长度一致、按下标对应的分数数组。 */
  rerank(query: string, docs: string[], opts?: RerankBatchOptions): Promise<number[]>
  readonly model: string
}

/** 上游 rerank 响应结构（OpenAI-compatible 形状）。 */
interface RerankItem {
  index?: number
  relevance_score?: number
  score?: number
}
interface RerankResponse {
  results?: RerankItem[]
}

/** 硅基流动中国站 bge-reranker 实现。 */
export class SiliconFlowReranker implements RerankProvider {
  readonly model: string
  private readonly endpoint: string
  private readonly pool: KeyPool
  private readonly fetchImpl: typeof fetch

  constructor(
    cfg: { model: string; endpoint?: string },
    pool: KeyPool,
    fetchImpl: typeof fetch = defaultFetch,
  ) {
    this.model = cfg.model
    this.endpoint = (cfg.endpoint ?? "https://api.siliconflow.cn/v1/rerank").replace(/\/+$/, "")
    this.pool = pool
    this.fetchImpl = fetchImpl
  }

  /** 对单个 key 发起一次上游 rerank 调用，塞入 batchSize 对。 */
  private async callRerank(
    key: PoolKey,
    query: string,
    docs: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; data?: RerankResponse; text?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.secret}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          query,
          // 超长截断：避免上游 413/入参过长抛错（与 embedding buildInput 对齐）。
          documents: docs.map((d) => d.slice(0, 8000)),
        }),
      })
      if (resp.ok) {
        const data = (await resp.json()) as RerankResponse
        return { ok: true, status: resp.status, data }
      }
      const t = await resp.text().catch(() => "")
      return { ok: false, status: resp.status, text: t }
    } catch (e) {
      // 超时/网络错误信号由 withKeyRetry 捕获并按可换 key 处理
      throw e
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 对 (query, docs) 批量打 relevance score。
   * 按 batchSize 分批（一次 HTTP 一批），分内通过 withKeyRetry 走 llm_pool 自动换 key 重试。
   */
  async rerank(query: string, docs: string[], opts?: RerankBatchOptions): Promise<number[]> {
    if (docs.length === 0) return []
    const batchSize = opts?.batchSize ?? 32
    const timeoutMs = opts?.timeoutMs ?? 15_000

    const out: number[] = []
    const q = query.trim()
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize)
      const resp = await withKeyRetry(this.pool, "rerank", (key) =>
        this.callRerank(key, q, batch, timeoutMs).then((r) => ({
          ok: r.ok,
          status: r.status,
          json: () => Promise.resolve(r.data),
          text: () => Promise.resolve(r.text ?? ""),
        })),
      )
      if (!resp.ok) {
        const detail = await resp.text?.().catch(() => "")
        throw new Error(`rerank-failed status=${resp.status} detail=${(detail ?? "").slice(0, 200)}`)
      }
      const data = (await (resp.json ? resp.json() : Promise.resolve(undefined))) as RerankResponse | undefined
      const results = data?.results
      if (!results || results.length !== batch.length) {
        throw new Error(`rerank-count-mismatch expected=${batch.length} got=${results?.length ?? 0}`)
      }
      // 按上游返回的 index 还原到本批对应位置；缺 index 时退化为返回顺序。
      const scores = new Array<number>(batch.length)
      for (const r of results) {
        const idx = typeof r.index === "number" ? r.index : scores.findIndex((_) => _ === undefined)
        const s = typeof r.relevance_score === "number" ? r.relevance_score : typeof r.score === "number" ? r.score : 0
        if (idx >= 0 && idx < batch.length) scores[idx] = s
      }
      out.push(...scores)
    }
    return out
  }
}

/** 用 env 构造 KeyPool 后实例化硅基流动 rerank provider 的工厂。rerank 并入 llm_pool（§2）。 */
export function createRerankProvider(
  env: {
    EMBED_POOL_KEYS?: string
    LLM_POOL_KEYS?: string
    RERANK_POOL_KEYS?: string
    RERANK_ENDPOINT?: string
    RERANK_MODEL?: string
  },
  db: KeyPoolDb,
  fetchImpl: typeof fetch = defaultFetch,
  /**
   * T3.3 运行时效：admin 下架的 ref（`{ rerank: ["rerank-key-0"] }`）。
   * 可选、缺省 = 无禁用（fail-open）——读不到禁用集绝不能影响检索。
   */
  options: KeyPoolOptions = {},
): { pool: KeyPool; provider: RerankProvider } {
  const pool = new KeyPool(env, db, options)
  const provider = new SiliconFlowReranker(
    {
      model: env.RERANK_MODEL ?? "BAAI/bge-reranker-v2-m3",
      endpoint: env.RERANK_ENDPOINT,
    },
    pool,
    fetchImpl,
  )
  return { pool, provider }
}