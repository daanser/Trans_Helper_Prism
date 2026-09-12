// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf EmbeddingProvider (plan.md §5.3)
// 供应商锁定：硅基流动中国站 bge 系列。抽象为接口以保留切换能力（§8.5 逃生通道）。
// 所有 key 走 KeyPool（embed_pool）；401/403/429/超时自动换 key 重试一次；失败抛错给上层降级。

import {
  KeyPool,
  PoolKey,
  withKeyRetry,
  KeyPoolDb,
  KeyPoolOptions,
  shouldRetryStatus,
  envString,
} from "./keypool"

/** 调用方向：query（检索）或 document（入库）。二者共用同一 instruction prefix（§5.3）。 */
export interface EmbedOpts {
  kind?: "query" | "document"
  /** batch/退避等批量参数（见 EmbedBatchOptions）。 */
  batch?: EmbedBatchOptions
}

/** Embedding 提供方的最小契约。换供应商只换实现，不动链路。 */
export interface EmbeddingProvider {
  /** 单条文本嵌入。query 与 document 共用同一 instruction prefix（§5.3）。 */
  embed(text: string, opts?: EmbedOpts): Promise<number[]>
  /** 批量嵌入（ingest / 搜索 query 批量时用）。一次 HTTP 塞多条，429 自动退避+换 key。 */
  embedBatch(texts: string[], opts?: EmbedOpts): Promise<number[][]>
  readonly model: string
  readonly dim: number
}

/** 上游 embedding 响应结构（OpenAI-compatible 形状）。 */
interface EmbeddingResponse {
  data: { embedding: number[] }[]
}

/** workerd 原生 fetch 必须以正确 this 调用，直接存引用再 this.fetchImpl() 会 Illegal invocation；
 * 默认实现包一层箭头函数保持绑定（Node 下无此问题，故单测抓不到，只能真 worker 抓）。 */
export const defaultFetch: typeof fetch = (...args) => fetch(...args)

/** 单次批量嵌入的配置（batch/退避/重试，均可配，主要用于 ingest）。 */
export interface EmbedBatchOptions {
  /** 一次 HTTP 塞入的最大文本条数。默认 32。 */
  batchSize?: number
  /** 429/5xx 重试上限（指数退避）。默认 6。 */
  maxRetries?: number
  /** 首次退避基准毫秒。默认 500。 */
  baseBackoffMs?: number
  /** 是否对 429 做指数退避等待（默认 true）。 */
  backoffOn429?: boolean
  /** 测试注入的 sleep 实现（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 粗估 token 数：按 ~1.8 token/汉字 估算（plan.md §5.3 dry-run 成本测算用）。 */
export function estimateTokens(texts: readonly string[]): number {
  let total = 0
  for (const t of texts) {
    const cjk = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
    const latinWords = (t.match(/[A-Za-z0-9]+/g) ?? []).length
    total += cjk * 1.8 + latinWords * 1.3
  }
  return Math.round(total)
}

/** 把 items 按 batchSize 切成若干批。 */
export function chunkBatches<T>(items: readonly T[], batchSize: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize))
  }
  return out
}

/** 硅基流动中国站 bge 实现。 */
export class SiliconFlowEmbedding implements EmbeddingProvider {
  readonly model: string
  readonly dim: number
  private readonly endpoint: string
  private readonly pool: KeyPool
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    cfg: {
      model: string
      dim: number
      endpoint?: string
      /** 单次 embedding 上游硬超时（毫秒，T1.3 配置项）。默认 15s。 */
      timeoutMs?: number
    },
    pool: KeyPool,
    fetchImpl: typeof fetch = defaultFetch,
  ) {
    this.model = cfg.model
    this.dim = cfg.dim
    this.endpoint = (cfg.endpoint ?? "https://api.siliconflow.cn/v1/embeddings").replace(/\/+$/, "")
    this.pool = pool
    this.fetchImpl = fetchImpl
    this.timeoutMs = cfg.timeoutMs ?? 15_000
  }

  /** 与 query 共用同一 instruction prefix（§5.3：否则精度崩）。 */
  private buildInput(text: string, _kind: "query" | "document"): string {
    const safe = text.slice(0, 8000) // 超长截断，绝不抛错
    // TODO(M1): 若中文 bge 需要 instruction prefix 区分 query/document，在此拼接并统一。
    return safe
  }

  private async callEmbedding(
    key: PoolKey,
    input: string,
    kind: "query" | "document",
  ): Promise<{ status: number; ok: boolean; data?: EmbeddingResponse; text?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs) // T1.3：超时做成配置项
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
          input: this.buildInput(input, kind),
        }),
      })
      if (resp.ok) {
        const data = (await resp.json()) as EmbeddingResponse
        return { ok: true, status: resp.status, data }
      }
      const t = await resp.text().catch(() => "")
      return { ok: false, status: resp.status, text: t }
    } catch (e) {
      // 超时/网络错误的信号由 withKeyRetry 捕获并按可换 key 处理
      throw e
    } finally {
      clearTimeout(timeout)
    }
  }

  async embed(text: string, opts?: EmbedOpts): Promise<number[]> {
    const kind = opts?.kind ?? "document"
    const input = this.buildInput(text, kind)
    const resp = await withKeyRetry(
      this.pool,
      "embed",
      (key) =>
        this.callEmbedding(key, input, kind).then((r) => ({
          ok: r.ok,
          status: r.status,
          json: () => Promise.resolve(r.data),
          text: () => Promise.resolve(r.text ?? ""),
        })),
      {
        // 记账（T3.2/T3.3）：把检索用量的 key/结果/耗时写进 key_usage，便于按账号统计
        onAttempt: (rec) => {
          void this.pool.recordUsage({
            pool: "embed",
            keyRef: rec.keyRef,
            endpoint: "embeddings",
            model: this.model,
            status: rec.status,
            statusCode: rec.statusCode,
            latencyMs: rec.latencyMs,
            tokensIn: estimateTokens([input]),
          })
        },
      },
    )
    if (!resp.ok) {
      // 换 key 后仍失败：抛错给上层降级（§8.5 池全灭→回退分支）
      const detail = await resp.text?.().catch(() => "")
      throw new Error(`embedding-failed status=${resp.status} detail=${(detail ?? "").slice(0, 200)}`)
    }
    const data = (await (resp.json ? resp.json() : Promise.resolve(undefined))) as EmbeddingResponse | undefined
    const first = data?.data?.[0]?.embedding
    if (!first) throw new Error("embedding-empty-response")
    if (first.length !== this.dim) {
      // 维度与配置不符：抛错避免把错误维度向量写进 Qdrant（§5.3 版本字段一致）。
      throw new Error(`embedding-dim-mismatch expected=${this.dim} got=${first.length}`)
    }
    return first
  }

  /** 向硅基流动发一批文本，返回对应顺序的向量。失败/429 走池内换 key + 指数退避重试。 */
  private async callBatchWithRetry(
    texts: string[],
    kind: "query" | "document",
    options: EmbedBatchOptions,
  ): Promise<number[][]> {
    const maxRetries = options.maxRetries ?? 6
    const baseBackoff = options.baseBackoffMs ?? 500
    const backoffOn429 = options.backoffOn429 ?? true
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

    let lastError: Error | null = null
    let attempt = 0
    while (attempt <= maxRetries) {
      const key = this.pool.pickKey("embed")
      if (!key) {
        // 池里无可用 key：等待一个退避周期再试（等冷却恢复）。
        if (attempt < maxRetries) {
          const wait = Math.min(baseBackoff * 2 ** attempt, 60_000)
          await sleep(wait)
          attempt++
          continue
        }
        throw new Error(`keypool: pool=embed 重试 ${maxRetries} 次后仍无可用 key`)
      }

      const input = texts.map((t) => this.buildInput(t, kind))
      let status = 0
      let text = ""
      try {
        const resp = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` },
          body: JSON.stringify({ model: this.model, input }),
        })
        if (resp.ok) {
          const data = (await resp.json()) as EmbeddingResponse
          const vectors = data.data?.map((d) => d.embedding)
          if (!vectors || vectors.length !== texts.length) {
            this.pool.releaseKey("embed", key.ref)
            throw new Error(`embedding-batch-mismatch expected=${texts.length} got=${vectors?.length ?? 0}`)
          }
          if (vectors.some((v) => v.length !== this.dim)) {
            this.pool.releaseKey("embed", key.ref)
            throw new Error(`embedding-dim-mismatch expected=${this.dim}`)
          }
          this.pool.releaseKey("embed", key.ref)
          void this.pool.recordUsage({
            pool: "embed",
            keyRef: key.ref,
            endpoint: "embeddings",
            model: this.model,
            status: "ok",
            statusCode: resp.status,
            tokensIn: estimateTokens(texts),
          })
          return vectors
        }
        status = resp.status
        text = (await resp.text().catch(() => "")) || ""
      } catch (e) {
        // 网络/超时错误：同样按可换 key 处理
        lastError = e as Error
      }

      // 本次尝试失败：记录失败（会使该 key 进入冷却/可能剔除），换 key 并指数退避再试
      this.pool.releaseKey("embed", key.ref)
      const reason = status ? `upstream-${status}` : `error:${(lastError?.message ?? "unknown").slice(0, 200)}`
      await this.pool.reportFailure("embed", key.ref, reason)
      void this.pool.recordUsage({
        pool: "embed",
        keyRef: key.ref,
        endpoint: "embeddings",
        model: this.model,
        status: "failed",
        statusCode: status || undefined,
        tokensIn: estimateTokens(texts),
      })

      // 429 / 5xx / 网络错误：退避后重试（换一个 key 或等本 key 冷却）
      const retryable = status === 0 || shouldRetryStatus(status)
      if (!retryable && backoffOn429 === false) {
        // 非可重试错误码且显式关闭退避：直接抛错
        throw new Error(`embedding-batch-failed status=${status} detail=${text.slice(0, 200)}`)
      }
      if (attempt < maxRetries) {
        const wait = Math.min(baseBackoff * 2 ** attempt, 60_000)
        await sleep(wait)
        attempt++
      } else {
        throw new Error(
          `embedding-batch-failed status=${status || "network"} detail=${text.slice(0, 200)} after ${maxRetries} retries`,
        )
      }
    }
    throw lastError ?? new Error(`embedding-batch-failed after ${maxRetries} retries`)
  }

  async embedBatch(texts: string[], opts?: EmbedOpts): Promise<number[][]> {
    if (texts.length === 0) return []
    const kind = opts?.kind ?? "document"
    const batchOpts = opts?.batch ?? {}
    const batchSize = batchOpts.batchSize ?? 32
    const out: number[][] = []
    for (const batch of chunkBatches(texts, batchSize)) {
      const vectors = await this.callBatchWithRetry(batch, kind, batchOpts)
      out.push(...vectors)
    }
    return out
  }
}

/** 用 env 构造 KeyPool 后实例化硅基流动 embedding provider 的工厂。 */
export function createEmbeddingProvider(
  /**
   * 任意 env 形状：密钥来自 `POOL_KEYS_<n>`（动态前缀扫描，见 keypool.ts），
   * 其余配置项用 `envString()` 读 —— 所以这里不再逐个声明字段。
   */
  env: unknown,
  db: KeyPoolDb,
  fetchImpl: typeof fetch = defaultFetch,
  /**
   * T3.3 运行时效：admin 下架的 ref（`{ embed: ["embed-key-1"] }`）。
   * 可选、缺省 = 无禁用（fail-open）——读不到禁用集绝不能影响检索。
   */
  options: KeyPoolOptions = {},
): { pool: KeyPool; provider: EmbeddingProvider } {
  const pool = new KeyPool(env, db, options)
  const provider = new SiliconFlowEmbedding(
    {
      model: envString(env, "EMBEDDING_MODEL") ?? "BAAI/bge-m3",
      dim: parseInt(envString(env, "EMBEDDING_DIM") ?? "1024", 10),
      endpoint: envString(env, "EMBEDDING_ENDPOINT"),
      timeoutMs: parseTimeoutMsSafe(envString(env, "EMBED_TIMEOUT_MS")),
    },
    pool,
    fetchImpl,
  )
  return { pool, provider }
}

/** 解析超时毫秒（env 覆盖，默认 15s）。局部调用避免环依赖 search.ts 的 parseTimeoutMs。 */
function parseTimeoutMsSafe(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 15_000
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 15_000
}
