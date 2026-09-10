// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — D1 原子分档计数（plan-ratelimit.md §5）
//
// ── 为什么是 D1（而不是 KV）──
// 线上实测（plan §1）：经 Pages Function 反代后，同一 IP **13 秒连打 12 次全部 200、零 429**。
// 根因不是 IP 取错，而是 Worker→Worker 子请求会**跨 colo**，而 KV 是**最终一致**的：
// 各 colo 各写各的桶，计数永远不收敛（history.md §5 坑 23：KV 不能当精确计数器）。
// D1 是单点一致的 SQLite（每个 database 一个主副本），所以本模块用 D1 做**权威计数**。
// KV 那套限流（ratelimit.ts）保留不动：它仍是「同一 colo 内的廉价近似闸门」，只是不再作为判定依据。
//
// ── 原子性（照抄 quota.ts 的写法，已被并发测试验证过）──
//   UPDATE rate_counters SET count = count + 1, updated_at = ?
//    WHERE bucket_key = ? AND count < ?          -- 最后一个 ? = limit
//   `meta.changes === 1` = 本次成功占到一个名额；`=== 0` = 已满额（或被并发抢先占光）。
//   「判」与「占」在同一条语句里完成 → 并发下**绝不超卖**（不会出现 count > limit）。
//   行不存在时先 `INSERT OR IGNORE ... count = 0`（幂等；并发下只有一条生效）。
//
// ── 隐私：绝不落 IP 明文（plan §5「识别但不存储」）──
// 表里**没有 IP 列**，`bucket_key = HMAC_SHA256(key, "<scope>|<tier>|<ip>|<windowIndex>")` 的十六进制。
// ⚠️ 必须是 **HMAC**，不能是裸 `sha256(ip)`：IPv4 只有 2^32 个值，裸哈希可被彩虹表穷举反推。
// HMAC 的 key 见 `deriveRateLimitHmacKey()`（从 PROXY_SHARED_SECRET 派生，**不新增 secret**）。
// IP 只在本函数**栈上**参与 HMAC 计算，随即丢弃：不进 D1、不进日志、不进审计（whoami 除外）。
//
// ── 降级：可用性优先（与 quota.ts 同一套哲学）──
// D1 缺失 / 任何 SQL 异常 → `{ ok: true, degraded: true }` **放行**，由调用方打 warning。
// 宁可放行（少挡一点刷量），也不要因为 D1 抖动把整站搜索打死。
//
// ── 写放大（history.md §5 坑 14：D1 免费版 100k 写/天）──
// 正常请求 = 1 次条件 UPDATE（写 1 行）+ 1 次计数回读（读 1 行）：
//   约等于「每天 10 万次匿名检索」的上限，与 plan §5「默认先上：每次匿名 /search 写 1 行」一致。
// 突发桶（10s）**只在计数已经很高时才写**（见 index.ts 的 rateGate），避免给正常流量翻倍写。
// 过期行由 `purgeExpiredCounters()` 顺手清理（不引入定时任务，plan §5 / §10）。

/** 计数作用域：搜索、LLM、全局匿名、突发、封禁各占一个桶。 */
export type RateScope = "search" | "llm" | "global" | "burst" | "block"

/** `consumeRateToken` 入参。 */
export interface ConsumeRateTokenArgs {
  /** 作用域（决定桶命名空间；搜索与 LLM 分别计数、互不占用额度）。 */
  scope: RateScope
  /** HMAC 密钥（**不是** secret 本身，见 `deriveRateLimitHmacKey`）。 */
  hmacKey: string
  /** 客户端 IP —— **只用于算 HMAC**，绝不出现在返回值/落库字段里。 */
  ip?: string
  /**
   * 桶身份分量（plan §5 公式里的 `tierOrGlobal`）：
   * · `search` / `llm` / `burst` 传档位（`logged_in` / `cn_idc` / …）；
   * · `global` 缺省即 `"global"`（全局匿名熔断是**一个**桶，与 IP 无关）；
   * · `block` 传档位（封禁按 IP 生效）。
   */
  tier?: string
  /** 窗口长度（秒）。 */
  windowSec: number
  /** 窗口内允许次数（<= 0 = 一律拒绝，用于熔断兜底）。 */
  limit: number
  /** 当前时间（epoch ms；注入便于单测）。 */
  nowMs: number
}

/** `consumeRateToken` 结果。 */
export interface RateTokenResult {
  /** 是否放行（已计入本次） */
  ok: boolean
  /** 本窗口当前计数（含本次；D1 不可用时为 0） */
  count: number
  /** 生效限额（回显，便于 429 响应与诊断） */
  limit: number
  /** 被拒时建议的重试等待秒数（未拒为 0） */
  retryAfterSec: number
  /** D1 缺失/异常 → 已 fail-open 放行，调用方应打 warning */
  degraded: boolean
  /** 本次命中的桶 key（HMAC 摘要；仅供日志/诊断，**不含 IP**） */
  bucketKey: string
}

/** D1 绑定（允许 undefined/null 以便优雅降级；与 quota.ts 的 QuotaDb 同形）。 */
export type RateCountDb = D1Database | null | undefined

/**
 * 未配 `PROXY_SHARED_SECRET` 时使用的**固定** HMAC 密钥。
 *
 * ⚠️ 这不是密钥，是一句占位符：**隐私强度下降**（攻击者拿不到密钥时无法穷举 IP，
 * 但本常量是公开的 → 等于裸哈希，IPv4 可被彩虹表反查）。
 * 生产**必须**配 `PROXY_SHARED_SECRET`（两处同值），否则 `deriveRateLimitHmacKey()`
 * 会返回本常量，并在调用方打 warning。行为本身仍然正确（计数照常），只是匿名化强度退化。
 */
export const RATE_LIMIT_HMAC_KEY_FALLBACK = "prism-ratelimit-v1|insecure-no-proxy-secret"

/** 派生用的域分隔前缀（轮换/换算法时改这里 = 让所有旧计数器失效，可接受，plan §5）。 */
const RATE_LIMIT_HMAC_LABEL = "prism-ratelimit-v1"

/** hex 编码（小写）。 */
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * HMAC-SHA256(hmacKey, message) → 小写 hex。
 * 用 WebCrypto（`crypto.subtle`），Workers 与 Node 18+ 都可用，零依赖。
 */
export async function hmacSha256Hex(hmacKey: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return toHex(sig)
}

/** SHA-256 → 小写 hex。 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return toHex(buf)
}

/**
 * 从 env 派生计数用的 HMAC 密钥（**不新增 secret**，plan §5）。
 * `SHA-256("prism-ratelimit-v1|" + PROXY_SHARED_SECRET)` 的 hex；
 * 未配置（或配成非字符串）→ `RATE_LIMIT_HMAC_KEY_FALLBACK`（隐私强度下降，调用方打 warning）。
 *
 * 轮换 `PROXY_SHARED_SECRET` 会让所有计数器桶名变化 = 计数从头开始（plan §5 已接受）。
 */
export async function deriveRateLimitHmacKey(env: unknown): Promise<string> {
  const secret =
    typeof env === "object" && env !== null ? (env as Record<string, unknown>)["PROXY_SHARED_SECRET"] : undefined
  if (typeof secret !== "string" || secret.trim() === "") return RATE_LIMIT_HMAC_KEY_FALLBACK
  return sha256Hex(`${RATE_LIMIT_HMAC_LABEL}|${secret}`)
}

/** 是否用的是退化密钥（调用方据此打 warning；**绝不回显密钥本身**）。 */
export function isDegradedHmacKey(key: string): boolean {
  return key === RATE_LIMIT_HMAC_KEY_FALLBACK
}

/** 固定窗口序号：`floor(nowMs / (windowSec*1000))`（windowSec 非法 → -1）。 */
export function windowIndex(nowMs: number, windowSec: number): number {
  if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(nowMs)) return -1
  return Math.floor(nowMs / (windowSec * 1000))
}

/** 窗口起点（epoch ms；windowSec 非法 → nowMs）。 */
export function windowStart(nowMs: number, windowSec: number): number {
  const idx = windowIndex(nowMs, windowSec)
  if (idx < 0) return nowMs
  return idx * windowSec * 1000
}

/** 距本窗口结束的秒数（向上取整，最小 1）。 */
export function retryAfterSecFor(nowMs: number, windowSec: number): number {
  const idx = windowIndex(nowMs, windowSec)
  if (idx < 0) return 1
  return Math.max(1, Math.ceil(((idx + 1) * windowSec * 1000 - nowMs) / 1000))
}

/**
 * 桶 key：`HMAC_SHA256(hmacKey, "<scope>|<tier|global>|<ip>|<windowIndex>")` 的 hex。
 * **不含 IP 明文**（plan §5 隐私验收项），且无密钥无法反推（HMAC，不是裸哈希）。
 */
export async function bucketKeyFor(args: {
  scope: RateScope
  hmacKey: string
  ip?: string
  tier?: string
  nowMs: number
  windowSec: number
}): Promise<string> {
  const identity = args.scope === "global" ? "global" : (args.tier ?? "unknown")
  const ip = args.scope === "global" ? "" : (args.ip ?? "")
  const idx = windowIndex(args.nowMs, args.windowSec)
  return hmacSha256Hex(args.hmacKey, `${args.scope}|${identity}|${ip}|${idx}`)
}

/** 写库用的 `tier` 列值（保留可读性，便于人工排查；不是隐私字段）。 */
function tierColumnValue(scope: RateScope, tier: string | undefined): string {
  if (scope === "global") return "anon_global"
  if (scope === "burst") return `burst:${tier ?? "unknown"}`
  if (scope === "block") return `block:${tier ?? "unknown"}`
  return tier ?? "unknown"
}

/** 读一行计数（异常 → null，由调用方按 fail-open 处理）。 */
async function readCount(db: D1Database, bucketKey: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT count FROM rate_counters WHERE bucket_key = ?")
    .bind(bucketKey)
    .first<{ count: number }>()
  return row && Number.isFinite(row.count) ? row.count : null
}

/**
 * 占一个名额（原子）。见文件头「原子性」与「隐私」两节。
 *
 * 返回 `{ ok, count, limit, retryAfterSec, degraded, bucketKey }`：
 *   · `ok=true`  → 放行（已计入本次）；
 *   · `ok=false` → 本窗口已满（或 limit<=0）→ 调用方回 429 + `Retry-After: retryAfterSec`；
 *   · `degraded=true` → D1 不可用，已 fail-open（调用方打 warning）。
 */
export async function consumeRateToken(db: RateCountDb, args: ConsumeRateTokenArgs): Promise<RateTokenResult> {
  const { scope, hmacKey, windowSec, limit, nowMs } = args
  const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 0

  // 参数非法：窗口无从计算 → 放行 + degraded（可用性优先）。
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowSec) || windowSec <= 0) {
    return { ok: true, count: 0, limit: safeLimit, retryAfterSec: 0, degraded: true, bucketKey: "" }
  }

  const bucketKey = await bucketKeyFor({ scope, hmacKey, ip: args.ip, tier: args.tier, nowMs, windowSec })
  const retryAfterSec = retryAfterSecFor(nowMs, windowSec)

  // limit <= 0：明确禁止（熔断兜底），不算 degraded（与 checkRateLimit 语义一致）。
  if (safeLimit <= 0) {
    return { ok: false, count: 0, limit: 0, retryAfterSec, degraded: false, bucketKey }
  }

  // D1 缺失 → 放行 + 标记（调用方打 warning）。
  if (!db) {
    return { ok: true, count: 0, limit: safeLimit, retryAfterSec: 0, degraded: true, bucketKey }
  }

  const start = windowStart(nowMs, windowSec)
  try {
    // ① 补行（幂等；并发下只有一条生效，已存在时写 0 行 = 不消耗写配额）
    await db
      .prepare(
        "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .bind(bucketKey, tierColumnValue(scope, args.tier), start, windowSec, nowMs)
      .run()

    // ② 单条原子「判-占」：changes===1 才算占到名额（并发下绝不超卖）
    const res = await db
      .prepare("UPDATE rate_counters SET count = count + 1, updated_at = ? WHERE bucket_key = ? AND count < ?")
      .bind(nowMs, bucketKey, safeLimit)
      .run()

    // ③ 回读当前计数（给调用方做突发闸门判断；读 1 行，不消耗写配额）
    const count = (await readCount(db, bucketKey)) ?? 0
    if (res?.meta?.changes === 1) {
      return { ok: true, count, limit: safeLimit, retryAfterSec: 0, degraded: false, bucketKey }
    }
    // changes === 0：已满额（或被并发抢先占光）→ 拒绝，绝不抛错
    return { ok: false, count, limit: safeLimit, retryAfterSec, degraded: false, bucketKey }
  } catch {
    // D1 异常 → fail-open（可用性优先）
    return { ok: true, count: 0, limit: safeLimit, retryAfterSec: 0, degraded: true, bucketKey }
  }
}

/** 只读当前窗口计数（**不占名额**，供 /admin/whoami 诊断用）。 */
export async function peekRateCount(
  db: RateCountDb,
  args: { scope: RateScope; hmacKey: string; ip?: string; tier?: string; windowSec: number; nowMs: number },
): Promise<{ count: number; degraded: boolean; bucketKey: string }> {
  const bucketKey = await bucketKeyFor({
    scope: args.scope,
    hmacKey: args.hmacKey,
    ip: args.ip,
    tier: args.tier,
    nowMs: args.nowMs,
    windowSec: args.windowSec,
  })
  if (!db) return { count: 0, degraded: true, bucketKey }
  try {
    const count = await readCount(db, bucketKey)
    // 注意：`readCount` 返回 null 有两种含义——「读出错」和「本窗口还没有行」（新窗口第一次请求前，完全正常）。
    // 二者混为一谈会让诊断把正常状态报成 degraded（线上曾据此误判限流失效）。真正的读异常由下面的 catch 兜住。
    return { count: count ?? 0, degraded: false, bucketKey }
  } catch {
    return { count: 0, degraded: true, bucketKey }
  }
}

/**
 * 读「封禁到什么时候」（epoch ms；未封禁 → 0）。
 * 封禁行实现：`scope="block"` 的桶，`count` 列**借用**存 `block_until`（epoch ms），
 * `window_sec` 存封禁时长，`window_start` 存写入时刻 —— 复用同一张表，不新增列/表（plan §6）。
 * 过期行靠 `purgeExpiredCounters` 清掉。
 */
export async function readBlockUntil(
  db: RateCountDb,
  args: { hmacKey: string; ip?: string; tier?: string; nowMs: number },
): Promise<number> {
  if (!db) return 0
  // 封禁桶与窗口序号无关（跨窗口持续生效）→ 用固定 index 0
  const bucketKey = await bucketKeyFor({
    scope: "block",
    hmacKey: args.hmacKey,
    ip: args.ip,
    tier: args.tier,
    nowMs: 0,
    windowSec: 60,
  })
  try {
    const row = await db
      .prepare("SELECT count FROM rate_counters WHERE bucket_key = ?")
      .bind(bucketKey)
      .first<{ count: number }>()
    const until = row && Number.isFinite(row.count) ? row.count : 0
    return until > args.nowMs ? until : 0
  } catch {
    return 0 // 读失败 → 不封禁（fail-open，可用性优先）
  }
}

/**
 * 写封禁（plan §6 单 IP 突发：`block_until = now + BURST_BLOCK_SEC`）。
 * 幂等：同一 IP 重复触发只会把 `count` 改成新的 block_until。失败静默（fail-open）。
 */
export async function writeBlockUntil(
  db: RateCountDb,
  args: { hmacKey: string; ip?: string; tier?: string; blockUntilMs: number; nowMs: number; blockSec: number },
): Promise<string | null> {
  if (!db) return null
  const bucketKey = await bucketKeyFor({
    scope: "block",
    hmacKey: args.hmacKey,
    ip: args.ip,
    tier: args.tier,
    nowMs: 0,
    windowSec: 60,
  })
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        bucketKey,
        tierColumnValue("block", args.tier),
        args.nowMs,
        Math.max(1, Math.floor(args.blockSec)),
        Math.floor(args.blockUntilMs),
        args.nowMs,
      )
      .run()
    await db
      .prepare("UPDATE rate_counters SET count = ?, window_start = ?, window_sec = ?, updated_at = ? WHERE bucket_key = ?")
      .bind(Math.floor(args.blockUntilMs), args.nowMs, Math.max(1, Math.floor(args.blockSec)), args.nowMs, bucketKey)
      .run()
    return bucketKey
  } catch {
    return null
  }
}

/**
 * 清理过期计数行（plan §5：窗口过期的行没有意义；**不引入定时任务**）。
 * 判定：`window_start < nowMs - minAgeMs`（默认 1h）→ 早已过期的窗口（最长窗口 60s）。
 * 用 `bucket_key IN (SELECT ... LIMIT ?)` 而不是 `DELETE ... LIMIT`（后者需要 SQLite 编译选项，
 * D1 不保证开启）。走 `idx_rate_counters_window`。返回删除行数；异常 → 0（**绝不抛错**）。
 */
export async function purgeExpiredCounters(
  db: RateCountDb,
  nowMs: number,
  opts: { minAgeMs?: number; batch?: number } = {},
): Promise<number> {
  if (!db) return 0
  const minAgeMs = Number.isFinite(opts.minAgeMs) ? (opts.minAgeMs as number) : 3_600_000
  const batch = Number.isFinite(opts.batch) && (opts.batch as number) > 0 ? Math.floor(opts.batch as number) : 500
  try {
    const res = await db
      .prepare(
        "DELETE FROM rate_counters WHERE bucket_key IN (SELECT bucket_key FROM rate_counters WHERE window_start < ? LIMIT ?)",
      )
      .bind(nowMs - minAgeMs, batch)
      .run()
    return res?.meta?.changes ?? 0
  } catch {
    return 0
  }
}
