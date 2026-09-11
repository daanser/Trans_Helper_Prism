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
import {
  anonGlobalHardLimit,
  anonGlobalLimit,
  llmDivisor,
  limitForTier,
  RATE_WINDOW_SEC,
  TIERS,
  type Tier,
} from "./tiers"

/**
 * 计数作用域：搜索、LLM、全局匿名、突发、封禁各占一个桶。
 * ⚠️ 每个 scope 在 `tier` 列里的写法见 `tierColumnValue`（search=裸档位、llm=`llm:` 前缀、
 * burst=`burst:` 前缀、block=`block:` 前缀、global=`anon_global`）——只读聚合靠它还原 scope。
 */
export type RateScope = "search" | "llm" | "global" | "burst" | "block"

/** 全局匿名熔断桶在 `tier` 列里的值（一个桶，与 IP 无关）。 */
export const GLOBAL_TIER_VALUE = "anon_global"
/** LLM 桶在 `tier` 列里的前缀（**只在 tier 列里**；桶 key 的 HMAC 输入不含前缀）。 */
export const LLM_TIER_PREFIX = "llm:"
/** 突发桶在 `tier` 列里的前缀。 */
export const BURST_TIER_PREFIX = "burst:"
/** 封禁行在 `tier` 列里的前缀（该行 `count` 列借存 `block_until`）。 */
export const BLOCK_TIER_PREFIX = "block:"

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
  if (scope === "global") return GLOBAL_TIER_VALUE
  if (scope === "burst") return `${BURST_TIER_PREFIX}${tier ?? "unknown"}`
  if (scope === "block") return `${BLOCK_TIER_PREFIX}${tier ?? "unknown"}`
  // ⚠️ `llm` 桶带 `llm:` 前缀（2026-09-10 起）：`tier` 列是**观测列**，而桶 key 的 HMAC 输入是
  //    `scope|tier|ip|windowIndex`（见 bucketKeyFor），**不含**本列的字符串 —— 所以这里加前缀
  //    **不改变任何桶身份**（计数器不会重置、判定顺序/阈值不变），只是让 `tier` 列能区分
  //    search 桶与 llm 桶（否则 /admin/ratelimit 无法分别报出两者的 buckets/counted）。
  //    部署前写入的 llm 行仍是裸档位名，最多 1 个窗口（60s）内会被并入 search 统计，之后自愈。
  if (scope === "llm") return `${LLM_TIER_PREFIX}${tier ?? "unknown"}`
  return tier ?? "unknown"
}

/** 三条热路径语句的**逐字** SQL（单条执行与 batch 共用同一份，杜绝两处漂移）。 */
const SQL_INSERT_COUNTER =
  "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, 0, ?)"
const SQL_OCCUPY_SLOT =
  "UPDATE rate_counters SET count = count + 1, updated_at = ? WHERE bucket_key = ? AND count < ?"
const SQL_SELECT_COUNT = "SELECT count FROM rate_counters WHERE bucket_key = ?"

/** 读一行计数（异常 → null，由调用方按 fail-open 处理）。 */
async function readCount(db: D1Database, bucketKey: string): Promise<number | null> {
  const row = await db.prepare(SQL_SELECT_COUNT).bind(bucketKey).first<{ count: number }>()
  return row && Number.isFinite(row.count) ? row.count : null
}

/** 从 batch 结果里取某条 SELECT 的第一行计数（缺行/脏值 → 0）。 */
function countFromResult(res: D1Result<unknown> | undefined): number {
  const rows = res?.results as Array<{ count?: unknown }> | undefined
  const raw = rows?.[0]?.count
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : 0
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
    // 三条语句**一次往返**（`db.batch` 是隐式事务，按序执行、按序返回结果）：
    //   ① 补行（幂等；并发下只有一条生效，已存在时写 0 行 = 不消耗写配额）
    //   ② 单条原子「判-占」：`meta.changes === 1` 才算占到名额（并发下绝不超卖）—— 判据与单条执行时**逐字相同**
    //   ③ 回读当前计数（给调用方做突发/熔断闸门判断）
    // 为什么能这么合：三条语句语义上本来就是「补行 → 判占 → 回读」，串行 + 同事务只会让结果更确定；
    // 阈值、判定顺序、fail-open 行为一律不变（唯一差别：整批失败会一起回滚，见下方 catch）。
    const [, occupyRes, selectRes] = await db.batch([
      db.prepare(SQL_INSERT_COUNTER).bind(bucketKey, tierColumnValue(scope, args.tier), start, windowSec, nowMs),
      db.prepare(SQL_OCCUPY_SLOT).bind(nowMs, bucketKey, safeLimit),
      db.prepare(SQL_SELECT_COUNT).bind(bucketKey),
    ])
    const count = countFromResult(selectRes)
    if (occupyRes?.meta?.changes === 1) {
      return { ok: true, count, limit: safeLimit, retryAfterSec: 0, degraded: false, bucketKey }
    }
    // changes === 0：已满额（或被并发抢先占光）→ 拒绝，绝不抛错
    return { ok: false, count, limit: safeLimit, retryAfterSec, degraded: false, bucketKey }
  } catch {
    // D1 异常 → fail-open（可用性优先）。
    // 注意：batch 是隐式事务，整批失败 → **本次自增也已回滚**（不会留下"占了名额但请求被放行"的脏状态）。
    // 这与优化前（逐条执行、前面成功后面失败时计数已落库）略有差别，但两者都属 fail-open 的一致语义：
    // 少记一次比"记了却放行"更保守，且没有超卖风险。
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
  const sec = Math.max(1, Math.floor(args.blockSec))
  const until = Math.floor(args.blockUntilMs)
  try {
    // 补行 + 写 block_until：一次往返（无论哪条失败都整批回滚 → 视为"没封上"，fail-open 语义不变）
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(bucketKey, tierColumnValue("block", args.tier), args.nowMs, sec, until, args.nowMs),
      db
        .prepare("UPDATE rate_counters SET count = ?, window_start = ?, window_sec = ?, updated_at = ? WHERE bucket_key = ?")
        .bind(until, args.nowMs, sec, args.nowMs, bucketKey),
    ])
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

// ─────────────────────────────────────────────────────────────────────────────
// 只读聚合：GET /api/v1/admin/ratelimit 的数据面（plan-ratelimit.md §10 R5 观测 / §11 验收）
// ─────────────────────────────────────────────────────────────────────────────
//
// ── 硬要求：不得新增任何**每请求写入** ──
// 匿名搜索现在已经是 3 行写/请求（分档桶 + 突发桶 + 全局桶，history.md §5 坑 38），再往上加写入会直接
// 抬高 D1 成本。所以本段**只有两条 SELECT**，全部从 `rate_counters` 现有行聚合出来：
//   ① 按 `(tier, window_start)` 分组的 buckets/counted（含 current 与 previous 两个窗口）；
//   ② 封禁行数（`tier LIKE 'block:%' AND count > now`，`count` 列借存 block_until）。
// **绝不写库**：单测用「任何 `run()` 被调用即失败」的 mock 把这条锁死（见 tests/ratelimitStats.test.ts）。
//
// ── 时间范围口径（写清，别猜）──
// 固定窗口按 epoch 对齐（`windowIndex`），窗口长 60s。聚合范围 = **当前窗口 + 上一个窗口**：
//   `range_start = windowStart(now) - (STATS_WINDOWS-1)*60s`，SQL 条件 `window_start >= range_start`。
// 于是：搜索/LLM 桶 = 最近 2 个 60s 桶之和（能看到窗口滚动前后的量级，不会因为刚跨窗口就显示空的 0）；
// 突发桶（window_sec=10）落在最近 2 分钟内 → 全部计入；全局熔断桶**只取当前窗口**（熔断看的是"这一分钟"）；
// 封禁行只要 `block_until > now` 就算（封禁时长恒 60s，必然落在范围内）。
//
// ── 为什么用 `window_start >= ?` ──
// 走 `idx_rate_counters_window`（range scan），**不是全表扫描**；再往上按 `tier` 分组，返回行数 ≤ 档位数×2。
//
// ── 隐私 ──
// 返回值只有聚合数（buckets/counted/……），**没有任何 bucket_key、没有任何 IP**（表里本来就没有 IP 列）。

/** 聚合覆盖的窗口数（当前窗口 + 上一个窗口；见上方时间范围口径）。 */
export const STATS_WINDOWS = 2

/** 单作用域聚合（buckets = 行数，counted = SUM(count)）。 */
export interface RateLimitScopeAgg {
  buckets: number
  counted: number
}

/** 单档位聚合（`limit` = 该档**搜索**限额；非标准档位名 → null，绝不编造数字）。 */
export interface RateLimitTierAgg {
  tier: string
  buckets: number
  counted: number
  limit: number | null
}

/** `GET /api/v1/admin/ratelimit` 响应体（全部为只读聚合，无 IP、无桶 key）。 */
export interface RateLimitStats {
  /** 本响应生成时刻（epoch ms） */
  now: number
  /** 计数窗口长度（秒） */
  window_sec: number
  /** 当前窗口起点（epoch ms） */
  window_start: number
  /** 聚合范围起点（epoch ms；= 上一个窗口起点） */
  range_start: number
  /** 各档位的桶数与计数（search + llm 桶合并按档位呈现；按 TIERS 顺序，只列有行的档位） */
  tiers: RateLimitTierAgg[]
  /** 各作用域的桶数与计数（与 tiers 同一时间范围；global 只取当前窗口） */
  scopes: { search: RateLimitScopeAgg; llm: RateLimitScopeAgg; burst: RateLimitScopeAgg; global: RateLimitScopeAgg }
  /** 处于封禁状态的行数（`tier LIKE 'block:%' AND count > now`） */
  blocked_buckets: number
  /** 全局匿名熔断：当前窗口计数 + 软/硬阈值 + 状态 */
  global: { count: number; soft: number; hard: number; state: "normal" | "soft" | "hard" }
  /** 当前生效的限额（来自 env，与 rateGate 同源） */
  limits: {
    logged_in: number
    cn_residential: number
    cn_other: number
    cn_idc: number
    overseas: number
    unknown: number
    llm_divisor: number
  }
  /**
   * 计数子系统是否处于降级状态。**当前唯一的降级源**：HMAC 密钥退化（未配 `PROXY_SHARED_SECRET`）
   * → 桶名的匿名化强度下降（等于裸哈希，IPv4 可被穷举反查）。
   * D1 缺失 / 读失败**不**在这里表达（那两种走 503，见路由）。
   */
  degraded: boolean
}

/** 分组查询的行形状（`SELECT tier, window_start, COUNT(*), SUM(count) ... GROUP BY tier, window_start`）。 */
export interface RateCounterAggRow {
  tier: unknown
  window_start: unknown
  buckets: unknown
  counted: unknown
}

function finiteNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 非负整数（脏数据兜底）。 */
function nonNegInt(v: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(v, 0)))
}

function emptyScopeAgg(): RateLimitScopeAgg {
  return { buckets: 0, counted: 0 }
}

/** 档位名 → 中文/标准名之外的兜底：只接受字符串，其它一律空串。 */
function tierNameOf(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * 纯函数：把 `rate_counters` 的聚合行 + 封禁行数折叠成 `/admin/ratelimit` 响应体。
 * 零 IO，便于单测穷举（给定行 → 断言 buckets/counted/by tier）。
 *
 * @param rows           `buildRateLimitStats` 的分组行（`tier`/`window_start`/`buckets`/`counted`）
 * @param blockedBuckets 封禁行数（`count > now` 的 block 行）
 * @param opts.nowMs     当前时刻（注入便于单测）
 * @param opts.env       env（限额/阈值同源，与 rateGate 完全一致）
 * @param opts.hmacDegraded HMAC 密钥是否退化（见 `isDegradedHmacKey`）→ 响应里的 `degraded`
 */
export function aggregateRateLimitRows(
  rows: readonly RateCounterAggRow[],
  blockedBuckets: number,
  opts: { nowMs: number; env?: unknown; hmacDegraded?: boolean },
): RateLimitStats {
  const env = opts.env ?? {}
  const windowSec = RATE_WINDOW_SEC
  const currentStart = windowStart(opts.nowMs, windowSec)
  const rangeStart = currentStart - (STATS_WINDOWS - 1) * windowSec * 1000

  const scopes = {
    search: emptyScopeAgg(),
    llm: emptyScopeAgg(),
    burst: emptyScopeAgg(),
    global: emptyScopeAgg(),
  }
  const byTier = new Map<string, RateLimitScopeAgg>()

  for (const row of rows) {
    const buckets = nonNegInt(row.buckets)
    const counted = nonNegInt(row.counted)
    const rawTier = tierNameOf(row.tier)
    const rowWindowStart = finiteNumber(row.window_start, Number.NaN)
    if (buckets <= 0 || rawTier === "" || !Number.isFinite(rowWindowStart)) continue

    if (rawTier === GLOBAL_TIER_VALUE) {
      // 全局熔断桶：只看**当前窗口**（跨窗口的残留行不是"这一分钟熔断到哪"的答案）
      if (rowWindowStart < currentStart) continue
      scopes.global.buckets += buckets
      scopes.global.counted += counted
      continue
    }
    if (rawTier.startsWith(BLOCK_TIER_PREFIX)) {
      // 封禁行由 blocked_buckets 单独表达（`count` 列是 block_until，不是计数，**不能**求和）
      continue
    }
    if (rawTier.startsWith(BURST_TIER_PREFIX)) {
      scopes.burst.buckets += buckets
      scopes.burst.counted += counted
      continue
    }

    const isLlm = rawTier.startsWith(LLM_TIER_PREFIX)
    const tier = isLlm ? rawTier.slice(LLM_TIER_PREFIX.length) : rawTier
    const scope = isLlm ? scopes.llm : scopes.search
    scope.buckets += buckets
    scope.counted += counted

    const cur = byTier.get(tier) ?? emptyScopeAgg()
    cur.buckets += buckets
    cur.counted += counted
    byTier.set(tier, cur)
  }

  // 档位呈现顺序：先按 TIERS（判定顺序），再把非标准档位名（理论上不该出现）按字典序附在后面
  const known = TIERS as readonly string[]
  const tiers: RateLimitTierAgg[] = []
  for (const tier of known) {
    const agg = byTier.get(tier)
    if (!agg) continue
    tiers.push({ tier, buckets: agg.buckets, counted: agg.counted, limit: limitForTier(tier as Tier, env) })
  }
  for (const tier of [...byTier.keys()].filter((t) => !known.includes(t)).sort()) {
    const agg = byTier.get(tier)!
    // 非标准档位名没有对应的限额来源 → null（**不编造**数字）
    tiers.push({ tier, buckets: agg.buckets, counted: agg.counted, limit: null })
  }

  const soft = anonGlobalLimit(env)
  const hard = anonGlobalHardLimit(env)
  const globalCount = scopes.global.counted
  // 与 rateGate 的判定**逐字对应**：`count > soft` 走软熔断（只给关键词回退）；
  // 硬熔断在 `count == hard` 时开始生效（原子「判-占」的 `WHERE count < hard` 不再命中）。
  const state: RateLimitStats["global"]["state"] = globalCount >= hard ? "hard" : globalCount > soft ? "soft" : "normal"

  return {
    now: opts.nowMs,
    window_sec: windowSec,
    window_start: currentStart,
    range_start: rangeStart,
    tiers,
    scopes,
    blocked_buckets: nonNegInt(blockedBuckets),
    global: { count: globalCount, soft, hard, state },
    limits: {
      logged_in: limitForTier("logged_in", env),
      cn_residential: limitForTier("cn_residential", env),
      cn_other: limitForTier("cn_other", env),
      cn_idc: limitForTier("cn_idc", env),
      overseas: limitForTier("overseas", env),
      unknown: limitForTier("unknown", env),
      llm_divisor: llmDivisor(env),
    },
    degraded: opts.hmacDegraded === true,
  }
}

/**
 * 读 `rate_counters` 并聚合出 `/admin/ratelimit` 响应体（**只读**，见本段文件头）。
 * D1 异常一律向上抛（路由回 503 `db-unavailable`），绝不返回编造的数字。
 */
export async function buildRateLimitStats(
  db: D1Database,
  env: unknown = {},
  nowMs: number = Date.now(),
  opts: { hmacDegraded?: boolean } = {},
): Promise<RateLimitStats> {
  const windowSec = RATE_WINDOW_SEC
  const currentStart = windowStart(nowMs, windowSec)
  const rangeStart = currentStart - (STATS_WINDOWS - 1) * windowSec * 1000

  // ① 分档/突发/全局桶：按 (tier, window_start) 分组（返回行数 ≤ 档位数 × 窗口数）
  const grouped = await db
    .prepare(
      `SELECT tier AS tier, window_start AS window_start, COUNT(*) AS buckets, SUM(count) AS counted
         FROM rate_counters
        WHERE window_start >= ? AND tier NOT LIKE ?
        GROUP BY tier, window_start`,
    )
    .bind(rangeStart, `${BLOCK_TIER_PREFIX}%`)
    .all<RateCounterAggRow>()

  // ② 封禁行数：`count` 列借存 block_until → 只有"还没过期"的才算（正在被封的 IP 数）
  const blockedRow = await db
    .prepare("SELECT COUNT(*) AS blocked FROM rate_counters WHERE window_start >= ? AND tier LIKE ? AND count > ?")
    .bind(rangeStart, `${BLOCK_TIER_PREFIX}%`, nowMs)
    .first<{ blocked: unknown }>()

  return aggregateRateLimitRows(grouped?.results ?? [], nonNegInt(blockedRow?.blocked), {
    nowMs,
    env,
    hmacDegraded: opts.hmacDegraded,
  })
}
