// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Key Pool (plan.md §8.5)
// Key 一律来自 Workers secrets（env 传入），绝不硬编码、绝不落日志或回显。
// 池按"随时会死一个 key"设计：轮询/最少在用优先 → 失败标记冷却或剔除 → 下一个重试。
// D1 用量记账通过注入的 DBLike 完成，便于单测 mock。

/** 池类型。embed 与 llm 分池隔离（§8.5：别把鸡蛋放一个号里）。rerank 并入 llm_pool 但用量分开记。 */
export type PoolName = "embed" | "llm" | "rerank"

/** 一次计费用量记录（准备写入 key_usage 表）。 */
export interface UsageRecord {
  pool: PoolName
  keyRef: string
  endpoint: "embeddings" | "rerank" | "chat"
  model: string
  status: "ok" | "failed"
  statusCode?: number
  tokensIn?: number
  tokensOut?: number
  latencyMs?: number
  cost?: number
}

/** D1 记账的最小接口（真实 D1 或测试 mock 都实现它）。 */
export interface KeyPoolDb {
  recordUsage(rec: UsageRecord): Promise<void>
  /** 可选：把失败持久化到 provider_keys，便于跨请求冷却/判定剔除。 */
  markFailure?(pool: PoolName, keyRef: string, reason: string): Promise<void>
  // ── 关于「跨请求禁用 / 剔除某个 key」的口径（改前先读，别再长出第二套真相源）──
  // **唯一真相源 = KV 禁用集 `keydeny:<pool>`**（见 keyadmin.ts 的 readDeniedPools / setKeyDenied）：
  //   · admin 在面板上禁用/恢复某个 key → 只写 KV；
  //   · 每个请求进来时 `KeyPool.usableKeys()` 按该集合过滤（KV 挂了/读失败 → 视为无禁用 = fail-open）；
  //   · 跨 isolate 立即生效，无需重建池。
  // `provider_keys.enabled` / `status` / `cooldown_until` **只用于管理端展示与审计**
  // （脱敏投影见 keyadmin.ts），**不参与**运行时的选 key 决策 —— 改了 DB 也不会自动生效。
  //
  // 历史：本接口曾有一个 `listActiveKeys?(pool): Promise<string[]>`，**从未被任何代码消费**
  // （2026-09-11 技术债清理删除）。它当年的设想是"从 D1 恢复池状态"，但那会引入第二套真相源，
  // 且可能与 KV 禁用集互相矛盾。**不要**把它加回来：要新增跨请求控制面就扩展 KV 禁用集。
}

/** 池内单个 key 的运行时状态。 */
export interface PoolKey {
  ref: string
  secret: string
  state: "idle" | "in-flight"
  inFlightCount: number
  cooldownUntil: number // epoch ms
  consecutiveFailures: number
  evicted: boolean
  lastError?: string // 泛化失败原因，绝不含 key 明文
}

/** plan: 冷却时间随失败次数指数退避（秒）。 */
const COOLDOWN_BASE_MS = 5_000
const MAX_COOLDOWN_MS = 120_000
/** 连续失败达此数直接剔除（evict）。 */
const MAX_CONSECUTIVE_FAILURES = 5

/** 把 env 中的 secrets（逗号分隔 key 串）解析成一组 key。 */
export function parsePoolKeys(raw: string | undefined, pool: PoolName): PoolKey[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((secret, i) => ({
      ref: `${pool}-key-${i}`,
      secret,
      state: "idle" as const,
      inFlightCount: 0,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      evicted: false,
    }))
}

/** KeyPool 构造可选项（全部可省：省了就是旧行为）。 */
export interface KeyPoolOptions {
  /**
   * admin 下架的 key ref（按池，形如 `{ embed: ["embed-key-1"], llm: ["llm-key-0"] }`）。
   * 缺省/空集合 = 无禁用（**fail-open**）：管理面读不到禁用集时检索/LLM 必须照常工作。
   */
  denied?: Partial<Record<PoolName, Iterable<string>>>
}

export class KeyPool {
  private readonly pools: Record<PoolName, PoolKey[]>
  private readonly db: KeyPoolDb
  /** 运行时警报：可用 key < 2 时置 true（§8.5 告警线），生产可接通知。 */
  private alertReady: Record<PoolName, boolean> = { embed: true, llm: true, rerank: true }
  /**
   * admin 下架的 ref（T3.3 运行时效）。默认全空 = 无禁用；
   * `setDenied()` 可在运行中热更新（禁用的 key 立刻不再被 pickKey 选中）。
   */
  private readonly denied: Record<PoolName, Set<string>> = {
    embed: new Set<string>(),
    llm: new Set<string>(),
    rerank: new Set<string>(),
  }

  constructor(
    env: { EMBED_POOL_KEYS?: string; LLM_POOL_KEYS?: string; RERANK_POOL_KEYS?: string },
    db: KeyPoolDb,
    options: KeyPoolOptions = {},
  ) {
    // embed/llm 必填；rerank 默认并入 llm（§2 决策：rerank 与 LLM 共用一批号）。
    const rerankRaw = env.RERANK_POOL_KEYS ?? env.LLM_POOL_KEYS
    this.pools = {
      embed: parsePoolKeys(env.EMBED_POOL_KEYS, "embed"),
      llm: parsePoolKeys(env.LLM_POOL_KEYS, "llm"),
      rerank: parsePoolKeys(rerankRaw, "rerank"),
    }
    this.db = db
    this.applyDenied(options.denied)
    this.checkAlertLevels()
  }

  /**
   * 热更新某池的禁用集合（admin 上架/禁用后调用，见 keyadmin.ts 的 KV 读取）。
   * **fail-open**：传 null/undefined/不可迭代对象 → 清空该池禁用（视为无禁用）；绝不抛错。
   */
  setDenied(pool: PoolName, refs: Iterable<string> | null | undefined): void {
    const next = new Set<string>()
    if (refs) {
      try {
        for (const ref of refs) {
          if (typeof ref === "string" && ref !== "") next.add(ref)
        }
      } catch {
        // 迭代过程异常 → 视为无禁用（fail-open），保留空集合
      }
    }
    this.denied[pool] = next
    this.checkAlertLevels()
  }

  /** 批量设置（index.ts 一次注入三个池）。 */
  applyDenied(map: Partial<Record<PoolName, Iterable<string>>> | null | undefined): void {
    for (const pool of ["embed", "llm", "rerank"] as PoolName[]) {
      this.setDenied(pool, map?.[pool])
    }
  }

  /** 该池当前被禁用的 ref（排序数组；供 admin 展示/单测断言）。 */
  deniedRefs(pool: PoolName): string[] {
    return [...this.denied[pool]].sort()
  }

  /** 该 ref 是否被 admin 下架。 */
  isDenied(pool: PoolName, ref: string): boolean {
    return this.denied[pool].has(ref)
  }

  /** 每个池可用 key 数（已剔除 evicted / 冷却中 / admin 禁用）。 */
  private usableKeys(pool: PoolName): PoolKey[] {
    const now = Date.now()
    const denied = this.denied[pool]
    return this.pools[pool].filter((k) => !k.evicted && now >= k.cooldownUntil && !denied.has(k.ref))
  }

  /** 选一个 key：优先最少在用（in-flight），其次轮询最旧 idle。 */
  pickKey(pool: PoolName): PoolKey | null {
    const usable = this.usableKeys(pool)
    if (usable.length === 0) return null
    usable.sort((a, b) => a.inFlightCount - b.inFlightCount || a.cooldownUntil - b.cooldownUntil)
    const chosen = usable[0]
    chosen.inFlightCount++
    chosen.state = "in-flight"
    return chosen
  }

  /** 记录一次成功，释放 in-flight，清零连续失败。 */
  releaseKey(pool: PoolName, keyRef: string): void {
    const k = this.findKey(pool, keyRef)
    if (!k) return
    k.inFlightCount = Math.max(0, k.inFlightCount - 1)
    k.state = "idle"
    k.consecutiveFailures = 0
  }

  /** 失败上报：标记冷却或剔除（连续失败达阈值）。 */
  async reportFailure(pool: PoolName, keyRef: string, reason: string): Promise<void> {
    const k = this.findKey(pool, keyRef)
    if (!k) return
    k.inFlightCount = Math.max(0, k.inFlightCount - 1)
    k.state = "idle"
    k.consecutiveFailures++
    k.lastError = reason.slice(0, 500) // 泛化信息，绝不含 key 明文（reason 由调用方保证不含 key）

    if (k.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      k.evicted = true
      k.cooldownUntil = 0
    } else {
      const base = COOLDOWN_BASE_MS * Math.pow(2, k.consecutiveFailures - 1)
      k.cooldownUntil = Date.now() + Math.min(base, MAX_COOLDOWN_MS)
    }
    this.checkAlertLevels()
    if (this.db.markFailure) {
      await this.db.markFailure(pool, keyRef, reason).catch(() => undefined)
    }
  }

  /** 用量记账（写入 D1 key_usage）。失败不阻塞主流程。 */
  async recordUsage(rec: UsageRecord): Promise<void> {
    try {
      await this.db.recordUsage(rec)
    } catch {
      // 记账失败不阻断业务；可在后续加强日志。
    }
  }

  /** 可用 key < 2 时置告警标记（§8.5）。 */
  private checkAlertLevels(): void {
    for (const pool of Object.keys(this.pools) as PoolName[]) {
      const wasReady = this.alertReady[pool]
      const count = this.usableKeys(pool).length
      const nowReady = count >= 2
      if (wasReady && !nowReady) {
        // TODO(M4/运营): 接通知（邮件/群机器人）。先打日志，不含 key 明文。
        console.warn(`[keypool] pool=${pool} 可用 key 数 ${count} < 2，请补货`)
      }
      this.alertReady[pool] = nowReady
    }
  }

  /** 可用 key 数（供 admin 查询 / 后续通知）。 */
  availableCount(pool: PoolName): number {
    return this.usableKeys(pool).length
  }

  /** 暴露池内所有 key 的运行时状态（admin 查看 / 单测断言用）。 */
  keys(pool: PoolName): PoolKey[] {
    return this.pools[pool]
  }

  private findKey(pool: PoolName, keyRef: string): PoolKey | undefined {
    return this.pools[pool].find((k) => k.ref === keyRef)
  }
}

/** 通过把方式自动重试一次：failureFn 对某个 key 发起调用，401/403/429/超时返回待换 key 信号。 */
export type RetryDecision =
  | { kind: "ok"; value: unknown }
  | { kind: "retry" }
  | { kind: "fatal"; error: Error }

export interface RetryAttemptInput {
  pool: PoolName
  key: PoolKey
  /** 真正发起上游调用。抛错或满足换 key 条件时返回 retry。 */
  attempt: (key: PoolKey) => Promise<ResponseLike>
}

/** 上游响应的最小形状（便于真实 fetch 与测试 mock 统一）。 */
export interface ResponseLike {
  ok: boolean
  status: number
  json?(): Promise<unknown>
  text?(): Promise<string>
}

/** 判定是否应换 key 的上游错误码（§8.5：401/403/429/余额不足/超时）。 */
export function shouldRetryStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 402 || status === 500 || status === 502 || status === 503
}

/**
 * 核心:带换 key 重试的调用器。
 * - 从池里取一个 key；
 * - 跑 attempt；若返回 retry-able 状态或抛错（含超时），reportFailure 并换下一个 key 重试一次；
 * - 换过 key 后仍失败则抛错给上层做最终降级。
 * 只重试一次，避免无限重试拖垮配额。
 */
/** 一次上游尝试的结果（仅供调用方记账，不参与重试决策）。 */
export interface KeyAttemptRecord {
  keyRef: string
  status: "ok" | "failed"
  statusCode?: number
  latencyMs: number
}

/**
 * 取一把 key 执行 attempt，失败按 shouldRetryStatus 换 key 重试。
 * `options.onAttempt` 在**每次尝试结束**时回调一次（成功/失败都回调），供 embeddings/rerank 记账；
 * 回调内抛错会被吞掉，绝不影响业务链路。
 */
export async function withKeyRetry(
  pool: KeyPool,
  poolName: PoolName,
  attempt: (key: PoolKey) => Promise<ResponseLike>,
  options: { maxRetries?: number; onAttempt?: (rec: KeyAttemptRecord) => void } = {},
): Promise<ResponseLike> {
  const maxRetries = options.maxRetries ?? 1
  const notify = (rec: KeyAttemptRecord): void => {
    try {
      options.onAttempt?.(rec)
    } catch {
      // 记账回调绝不阻断业务
    }
  }
  let key = pool.pickKey(poolName)
  if (!key) throw new Error(`keypool: pool=${poolName} 无可用 key`)

  let lastError: Error | null = null
  for (let attemptNo = 0; attemptNo <= maxRetries; attemptNo++) {
    const t0 = Date.now()
    try {
      const resp = await attempt(key)
      const latencyMs = Date.now() - t0
      if (resp.ok) {
        pool.releaseKey(poolName, key.ref)
        notify({ keyRef: key.ref, status: "ok", statusCode: resp.status, latencyMs })
        return resp
      }
      if (shouldRetryStatus(resp.status) && attemptNo < maxRetries) {
        // 换 key：记失败，取下一个，续试
        notify({ keyRef: key.ref, status: "failed", statusCode: resp.status, latencyMs })
        await pool.reportFailure(poolName, key.ref, `upstream-${resp.status}`)
        const next = pool.pickKey(poolName)
        if (!next) throw new Error(`keypool: pool=${poolName} 换 key 后仍无可用 key（首错 status=${resp.status}）`)
        key = next
        continue
      }
      // 非可换 key 错误码（如 400 参数错），或已到重试上限：失败并释放
      pool.releaseKey(poolName, key.ref)
      notify({ keyRef: key.ref, status: "failed", statusCode: resp.status, latencyMs })
      return resp
    } catch (e) {
      notify({ keyRef: key.ref, status: "failed", latencyMs: Date.now() - t0 })
      lastError = e as Error
      if (attemptNo < maxRetries) {
        await pool.reportFailure(poolName, key.ref, `error:${((e as Error).message ?? "unknown").slice(0, 200)}`)
        const next = pool.pickKey(poolName)
        if (!next) throw new Error(`keypool: pool=${poolName} 换 key 后仍无可用 key（首错 ${(e as Error).name}: ${((e as Error).message ?? "unknown").slice(0, 200)}）`)
        key = next
        continue
      }
      pool.releaseKey(poolName, key.ref)
      throw lastError
    }
  }
  throw lastError ?? new Error(`keypool: pool=${poolName} 重试耗尽`)
}

