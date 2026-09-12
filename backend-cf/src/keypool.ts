// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Key Pool (plan.md §8.5；2026-09-12 按 plan-keypool.md 合并为单池)
//
// ── 密钥来自哪（plan-keypool.md §2.1）──
// `POOL_KEYS_0` / `POOL_KEYS_1` / `POOL_KEYS_2` …… **按前缀扫描 env**，按数字升序入池（**不要求连续**）。
// 一个变量放一把 key（推荐）；放多把也可以（逗号分隔，ref 依次为 `pool-key-<n>`、`pool-key-<n>#2`…）。
// 完整 key 值**永不回显**：日志/错误/响应一律只出 ref。
// ⚠️ 旧的三个按能力命名的池变量**已彻底移除**（用户决定不做过渡期兼容；历史与取舍见 plan-keypool.md §2.4）。
//
// ── 为什么 ref 用变量名里的数字（关键修复）──
// 旧实现是 `${pool}-key-${索引}`：**删掉中间一把 key 会让后续 ref 全部移位**，而禁用集（KV）与
// `provider_keys` 表都是按 ref 记录的 → 错位 = 误伤（禁用了没坏的）或误放（放过了要禁的）。
// 现在 `POOL_KEYS_2` → `pool-key-2`：**增删别的变量都不影响既有 ref**（有单测锁死）。
//
// ── 单池 + 能力标签（§2.2）──
// 对外只有**一个池 `keys`**（`/admin/keys` 的 pools 只有一项）；但 `PoolName = embed|llm|rerank`
// 作为**能力标签**保留：`pickKey("embed"|"llm"|"rerank")` 三个入口指向**同一份 key 对象**。
// 于是 ① 调用点零改动；② `key_usage.pool` 继续按能力记账（**分能力用量统计不受影响**）。
//
// ── 负载均衡（§2.5）──
// 并列时按 **LRU**（最久未取用优先）而不是"稳定排序 → 永远第一把"：顺序请求也会在多把 key/多个账号间轮转，
// 把用量摊开（正对"防上游封号"这个真实目标）。

/** 能力标签：embedding / 聊天（含总结与追问）/ rerank。三者共用同一份 key（见文件头"单池 + 能力标签"）。 */
export type PoolName = "embed" | "llm" | "rerank"

/** 对外暴露的**唯一**池名（`/admin/keys` 的 `pools[].pool`）。 */
export const MERGED_POOL_NAME = "keys" as const

/** 变量名形状：`POOL_KEYS_<n>`（n 为数字，不要求连续）。 */
export const POOL_KEYS_VAR_RE = /^POOL_KEYS_(\d+)$/

/** env 里一个 `POOL_KEYS_<n>` 变量的原始值。 */
export interface PoolKeysVar {
  /** 变量名里的数字（用于 ref） */
  index: number
  /** 变量名（日志用；**不含** key 值） */
  name: string
  raw: string
}

/** 把任意 env 形状收窄成可索引记录（`Env` 是 interface、无索引签名，故运行时扫描需要这层）。 */
function asRecord(env: unknown): Record<string, unknown> {
  return typeof env === "object" && env !== null ? (env as Record<string, unknown>) : {}
}

/**
 * 从任意 env 形状安全读字符串（provider 工厂读自己的配置项用；`POOL_KEYS_<n>` 是动态键，
 * `Env` interface 没有索引签名，所以整条链路都按"运行时记录"读，不再逐项声明）。
 */
export function envString(env: unknown, key: string): string | undefined {
  const v = asRecord(env)[key]
  return typeof v === "string" ? v : undefined
}

/**
 * 扫描 env，收集所有 `POOL_KEYS_<n>`，**按数字升序**返回（`_0` 在前；不要求连续）。
 * 忽略空值与非法名；非字符串值（比如误配成数字）跳过。
 */
export function scanPoolKeyVars(env: unknown): PoolKeysVar[] {
  const out: PoolKeysVar[] = []
  for (const [name, value] of Object.entries(asRecord(env))) {
    const m = POOL_KEYS_VAR_RE.exec(name)
    if (!m) continue
    if (typeof value !== "string") continue
    const index = Number(m[1])
    if (!Number.isFinite(index)) continue
    out.push({ index, name, raw: value })
  }
  return out.sort((a, b) => a.index - b.index)
}

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
  /**
   * 取用序号（**不是墙钟时间**）：每次 `pickKey` 选中它时递增计数。
   * 用序号而不是 `Date.now()` 是因为同一毫秒内连续取用时时间戳相同 → 排序退化成"永远第一把"，
   * 正是这次要修的 bug（顺序请求只打第一把）。单调序号让 LRU 在任何时钟精度下都成立。
   */
  lastUsedAt: number
}

/** plan: 冷却时间随失败次数指数退避（秒）。 */
const COOLDOWN_BASE_MS = 5_000
const MAX_COOLDOWN_MS = 120_000
/** 连续失败达此数直接剔除（evict）。 */
const MAX_CONSECUTIVE_FAILURES = 5

/** 造一个干净的 PoolKey。 */
function makeKey(ref: string, secret: string): PoolKey {
  return {
    ref,
    secret,
    state: "idle",
    inFlightCount: 0,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    evicted: false,
    lastUsedAt: 0,
  }
}

/**
 * 解析合并池：扫描 `POOL_KEYS_<n>`（数字升序）→ 一组 `PoolKey`。
 *
 * ref 规则（§2.1）：变量里**第一把** = `pool-key-<n>`；同一个变量里的第 k 把（k≥2，逗号分隔）= `pool-key-<n>#k`。
 * 去重（§2.1 第 4 条）：同一把 key 值出现多次 → **保留数字更小的那个 ref**（升序遍历天然满足），并 warn 一次。
 * `onWarn` 可注入（单测断言用）；缺省 `console.warn`，消息里**只有 ref，绝不含 key 值**。
 */
export function parseMergedKeys(env: unknown, onWarn: (msg: string) => void = (m) => console.warn(m)): PoolKey[] {
  const out: PoolKey[] = []
  const seen = new Map<string, string>() // secret → 已保留的 ref
  for (const { index, raw } of scanPoolKeyVars(env)) {
    const secrets = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    secrets.forEach((secret, i) => {
      const ref = i === 0 ? `pool-key-${index}` : `pool-key-${index}#${i + 1}`
      const keptRef = seen.get(secret)
      if (keptRef !== undefined) {
        onWarn(`[keypool] 同一把 key 配了多次（${ref} 与 ${keptRef}）→ 去重，保留 ${keptRef}`)
        return
      }
      seen.set(secret, ref)
      out.push(makeKey(ref, secret))
    })
  }
  return out
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
  /** 合并后的唯一 key 列表（三个能力入口共用同一批对象 → in-flight/冷却/禁用都是全池共享）。 */
  private readonly keyList: PoolKey[]
  private readonly db: KeyPoolDb
  /** 运行时警报：可用 key < 2 时置 true（§8.5 告警线），生产可接通知。 */
  private alertReady = true
  /**
   * admin 下架的 ref（T3.3 运行时效）。**合并池后语义 = 全能力禁用**（一把 key 就是一个整体），
   * 所以这里是**一个**集合，三个能力入口共用；`setDenied(pool, refs)` 无论从哪个能力调用都改这一个集合
   * （调用点因此零改动）。默认空 = 无禁用，`setDenied()` 可热更新。
   */
  private denied: Set<string> = new Set<string>()
  /** 取用序号发生器（LRU 用；单调递增，见 PoolKey.lastUsedAt 的注释）。 */
  private pickSeq = 0

  constructor(env: unknown, db: KeyPoolDb, options: KeyPoolOptions = {}) {
    // 扫描 `POOL_KEYS_<n>`（数字升序）；只认这一种命名（旧变量名已移除，见文件头）
    this.keyList = parseMergedKeys(env)
    this.db = db
    this.applyDenied(options.denied)
    this.checkAlertLevels()
  }

  /**
   * 热更新禁用集合（admin 上架/禁用后调用，见 keyadmin.ts 的 KV 读取）。
   * **fail-open**：传 null/undefined/不可迭代对象 → 清空禁用（视为无禁用）；绝不抛错。
   * 合并池下 `pool` 只是"从哪个能力入口调进来的"，三个入口写的是**同一个**集合。
   */
  setDenied(_pool: PoolName, refs: Iterable<string> | null | undefined): void {
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
    this.denied = next
    this.checkAlertLevels()
  }

  /**
   * 批量设置（index.ts 一次注入）。
   *
   * ⚠️ 合并池下必须**先做并集再一次性写入**：三个能力入口共用同一个集合，而 `readDeniedPools()`
   * 三个槽位的内容本就相同；若像旧实现那样"逐个能力调用 setDenied"，后一次传 undefined 会把
   * 前一次刚写进去的禁用集**清空**（曾经真的这么错过一次：`{embed:[...]}` 注入后 availableCount 仍是 2）。
   */
  applyDenied(map: Partial<Record<PoolName, Iterable<string>>> | null | undefined): void {
    const union = new Set<string>()
    for (const pool of ["embed", "llm", "rerank"] as PoolName[]) {
      const refs = map?.[pool]
      if (!refs) continue
      try {
        for (const ref of refs) if (typeof ref === "string" && ref !== "") union.add(ref)
      } catch {
        // 不可迭代 → 跳过这一个能力的输入（fail-open）
      }
    }
    this.setDenied("embed", union)
  }

  /** 当前被禁用的 ref（排序数组；三个能力入口返回同一份）。 */
  deniedRefs(_pool: PoolName): string[] {
    return [...this.denied].sort()
  }

  /** 该 ref 是否被 admin 下架（**全能力生效**）。 */
  isDenied(_pool: PoolName, ref: string): boolean {
    return this.denied.has(ref)
  }

  /** 可用 key（已剔除 evicted / 冷却中 / admin 禁用）。三个能力入口同一份。 */
  private usableKeys(_pool: PoolName): PoolKey[] {
    const now = Date.now()
    return this.keyList.filter((k) => !k.evicted && now >= k.cooldownUntil && !this.denied.has(k.ref))
  }

  /**
   * 选一个 key：优先最少在用（in-flight），并列时 **LRU（最久未取用的优先）**，再并列看冷却。
   *
   * 为什么必须加 LRU（§2.5，线上实测）：原来是 `inFlightCount || cooldownUntil`，两把都空闲时
   * `Array.sort` 稳定 → 永远返回第一把 → **顺序请求全部打在 key#1 上**，第二把闲置（只在并发/失败时才用到）。
   * 现在顺序请求会在多把 key 之间轮转，把请求量摊到多个账号上（每个账号用量减半）——正对"防上游封号"。
   */
  pickKey(pool: PoolName): PoolKey | null {
    const usable = this.usableKeys(pool)
    if (usable.length === 0) return null
    usable.sort(
      (a, b) => a.inFlightCount - b.inFlightCount || a.lastUsedAt - b.lastUsedAt || a.cooldownUntil - b.cooldownUntil,
    )
    const chosen = usable[0]
    chosen.inFlightCount++
    chosen.state = "in-flight"
    chosen.lastUsedAt = ++this.pickSeq // 单调序号（不是墙钟：同毫秒内连续取用也要能轮转）
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

  /** 可用 key < 2 时置告警标记（§8.5）。合并池后只有一个池名 `keys`。 */
  private checkAlertLevels(): void {
    const count = this.usableKeys("embed").length
    const nowReady = count >= 2
    if (this.alertReady && !nowReady) {
      // TODO(M4/运营): 接通知（邮件/群机器人）。先打日志，不含 key 明文。
      console.warn(`[keypool] pool=${MERGED_POOL_NAME} 可用 key 数 ${count} < 2，请补货`)
    }
    this.alertReady = nowReady
  }

  /** 可用 key 数（供 admin 查询 / 后续通知）。三个能力入口同一份。 */
  availableCount(_pool: PoolName): number {
    return this.usableKeys("embed").length
  }

  /** 暴露池内所有 key 的运行时状态（admin 查看 / 单测断言用）。 */
  keysForRefs(_pool: PoolName): PoolKey[] {
    return this.keyList
  }

  /** 兼容旧名（`keys(pool)`）：返回同一份合并列表。 */
  keys(pool: PoolName): PoolKey[] {
    return this.keysForRefs(pool)
  }

  private findKey(_pool: PoolName, keyRef: string): PoolKey | undefined {
    return this.keyList.find((k) => k.ref === keyRef)
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

