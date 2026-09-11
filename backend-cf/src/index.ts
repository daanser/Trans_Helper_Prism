// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Hono entry (GPL-3.0)
// 依据 plan.md §9.3 预留路由结构。已实现：/healthz、/api/v1/search（纯向量+rerank+缓存+熔断）、
// /api/v1/corpora（T2.1）、/api/v1/tree/:wiki_id（T2.4）、Queue consumer + Cron（T2.2 增量管线）。
// 其余路由登记为占位/未实现（返回 501 not-yet），待 M3 填充。
import { Hono } from "hono"
import type { Context } from "hono"
import { cors } from "hono/cors"
import { Env, SearchRequest, SearchResponse } from "./types"
import { runSearch, validate, SearchValidationError } from "./search"
import { listWikis, collectionName, isValidCorpus, buildCorporaResponse } from "./wiki_registry"
import { fetchAllChunks, buildTree, QdrantScrollError } from "./tree"
import { ingestWiki, type IngestMessage } from "./ingest/incremental"
import { backfillWikiUrls } from "./backfillUrls"
import {
  startXLogin,
  exchangeXCode,
  upsertXAccount,
  issueSession,
  sessionFromHeader,
  loginRedirectUrl,
  frontendBase,
  AuthConfigError,
} from "./auth"
import {
  chargeQuota,
  computeQuotaCost,
  formatPct,
  getQuota,
  grantQuota,
  resetQuota,
  toQuotaResponse,
} from "./quota"
import {
  checkSubjectRateLimit,
  clientIpFromHeaders,
  kvRateLimitStore,
  PROXY_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  type RateLimitPolicy,
  rateLimitHeaders,
  resolveClientIp,
  resolveClientMeta,
  timingSafeEqualString,
  type ClientMetaCf,
  type ClientMetaSource,
} from "./ratelimit"
import {
  anonGlobalHardLimit,
  anonGlobalLimit,
  burstPer10s,
  BURST_BLOCK_SEC,
  BURST_WINDOW_SEC,
  decideTier,
  isKnownHostingAsn,
  limitForTier,
  llmLimitForTier,
  RATE_WINDOW_SEC,
  type Tier,
} from "./tiers"
import {
  buildRateLimitStats,
  consumeRateToken,
  deriveRateLimitHmacKey,
  isDegradedHmacKey,
  peekRateCount,
  purgeExpiredCounters,
  readBlockUntil,
  writeBlockUntil,
} from "./ratecount"
import { listAudit, writeAudit } from "./audit"
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS, isToleratedSchemaError } from "./db/schemaStatements"
import { clampIngestRunsLimit, insertIngestRun, listIngestRuns, parseIngestRunInput } from "./ingestruns"
import { applyIngestFilesPlan, listZeroChunkFiles, parseIngestFilesInput } from "./ingestfiles"
import { runFallback, type FallbackResponse } from "./fallback"
import {
  buildPrompt,
  createChatProvider,
  isLlmUnavailable,
  LLM_UNAVAILABLE_NOTICE,
  type ChatMessage,
  type LlmHit,
  type LlmUsage,
} from "./llm"
import { appendRound, createSession, historyToMessages, isMaxRounds, loadContext } from "./chat"
import {
  callCustomModel,
  deleteCustomModel,
  listCustomModels,
  loadCustomModel,
  saveCustomModel,
} from "./custommodel"
import type { KeyPool, KeyPoolDb, UsageRecord } from "./keypool"
import {
  buildPoolInfos,
  fetchProviderKeyRows,
  isPoolName,
  isSafeKeyRef,
  kvDenyStore,
  poolRefsFromEnv,
  readDeniedPools,
  setKeyDenied,
  upsertProviderKey,
  type DeniedPools,
} from "./keyadmin"
import { buildAdminUsage } from "./adminstats"

/**
 * Key Pool 记账适配：把用量写进 D1 key_usage（失败不影响业务）。
 *
 * `accountId` = 发起这次调用的账号（会话 JWT 的 sub）；**匿名调用传空串**（仍然记账，
 * 只是不归属任何账号）。`/admin/usage` 的 per-account `requests` / `llm_tokens_*` 就靠这一列
 * （见 adminstats.ts 的口径说明 + schema.sql 的迁移注释）。
 */
export function makeKeyUsageDb(env: Env, accountId?: string): KeyPoolDb {
  const owner = typeof accountId === "string" ? accountId : ""
  return {
    async recordUsage(rec: UsageRecord) {
      if (!env.DB) return
      try {
        await env.DB.prepare(
          `INSERT INTO key_usage (id, account_id, pool, key_ref, endpoint, model, status, status_code, tokens_in, tokens_out, latency_ms, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            crypto.randomUUID(),
            owner,
            rec.pool,
            rec.keyRef,
            rec.endpoint,
            rec.model ?? "",
            rec.status,
            rec.statusCode ?? null,
            rec.tokensIn ?? 0,
            rec.tokensOut ?? 0,
            rec.latencyMs ?? null,
            rec.cost ?? 0,
            Date.now(),
          )
          .run()
      } catch {
        // 记账失败不影响业务
      }
    },
  }
}

/**
 * 按请求构造 chat provider（**带账号作用域的 usage db**）。
 *
 * ── 取舍（为什么不再是跨请求单例）──
 * 单例的 KeyPool 只有一份 db 引用，无法把「这次调用是谁发起的」传进去 → 账号维度记账不可能准。
 * 故改成每次请求 `createChatProvider(env, makeKeyUsageDb(env, accountId))`：
 *   · 收益：每一次 LLM 调用（含换 key 重试产生的失败行）都能归属到账号，/admin/usage 才有真值。
 *   · 代价：KeyPool 是**内存态**，新建池 = 丢掉跨请求的 key 冷却/剔除记忆。可接受，因为
 *     ① 失败同样写 key_usage（哪个号挂了在 DB 里看得见，不靠内存态）；
 *     ② admin 下架 key 走 KV 禁用集（`keydeny:<pool>`，见 keyadmin.ts），**跨请求仍然是硬控制面**；
 *     ③ 单次请求内 `withKeyRetry` 照常换 key 重试（冷却只在这一次请求内生效，够用）。
 * 若将来要找回跨请求冷却，可选：把禁用集扩成「冷却集」也放 KV，或在 llm.ts/keypool.ts 里把
 * usage db 改成按调用传入（都涉及本任务范围外的文件，故此处不做）。
 */
function chatProviderFor(env: Env, accountId: string | undefined) {
  return createChatProvider(env, makeKeyUsageDb(env, accountId))
}

/**
 * T3.3 运行时效：读 KV 的「admin 下架 key」集合（fail-open）。
 * 读 KV / 解析 / 任何异常 → 空集合（视为无禁用），**绝不影响检索与 LLM**。
 */
async function loadDeniedKeys(env: Env): Promise<DeniedPools> {
  try {
    return await readDeniedPools(kvDenyStore(env.SEARCH_CACHE), env)
  } catch {
    return { embed: [], llm: [], rerank: [] }
  }
}

/** 把禁用集合热更新到 chat 单例的池上（每次请求刷一次，KV 变更即时生效）。 */
function applyDeniedToPool(pool: KeyPool, denied: DeniedPools, poolName: "llm" | "rerank"): void {
  try {
    pool.setDenied(poolName, denied[poolName])
  } catch {
    // 任何异常 → 不放禁用（fail-open）
  }
}

/** SearchHit → LLM 输入（截断由 llm.ts 内部负责）。 */
function toLlmHits(hits: SearchResponse["hits"]): LlmHit[] {
  return hits.map((h) => ({ id: h.id, title: h.title, url: h.url, source: h.source, text: h.snippet }))
}

/**
 * 限流策略（env 可调）。匿名放开向量检索后，IP 维度是唯一的成本闸门，故默认收紧到 20 次/分钟；
 * 登录账号 60 次/分钟（另有配额计量兜底）。
 */
function rateLimitPolicy(env: Env): RateLimitPolicy {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    account: { limit: parse(env.RATE_LIMIT_ACCOUNT_PER_MIN, 60), windowSec: 60 },
    ip: { limit: parse(env.RATE_LIMIT_IP_PER_MIN, 20), windowSec: 60 },
  }
}

/** 未登录是否强制只走关键词回退（plan §2 登录制；REQUIRE_LOGIN=0 可关闭）。 */
function requireLogin(env: Env): boolean {
  return (env.REQUIRE_LOGIN ?? "1") !== "0"
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 分档限流接线（plan-ratelimit.md §4 分档 / §5 D1 计数 / §6 突发与熔断）
// ─────────────────────────────────────────────────────────────────────────────
//
// ── 与既有 KV 限流的关系 ──
// KV 那段（checkSubjectRateLimit）**原样保留**：它仍是「同一 colo 内的廉价近似闸门」，
// 直连流量还在用它。本段是**权威判定**：跨 colo 收敛（D1 单点一致），按档位给额度。
// 两者串联：先 KV（便宜、可能失准），再 D1（准、但每条请求 1 写 + 1 读）。
//
// ── 绝不打印 IP ──
// 本段所有日志只含档位/限额/原因（**没有 IP，没有密钥**）。IP 只在 ratecount 内部参与 HMAC，
// 随即丢弃（plan §5 隐私节：审计/错误日志/admin 面板一律不得输出 IP；whoami 除外，它是 admin 专用诊断）。

/** 拒绝原因（进 429 响应体与日志，便于线上定位是哪一层挡的）。 */
export type RateGateReason = "tier-limit" | "burst" | "blocked" | "global-hard"

/** 分档闸门的拒绝描述（由调用方拼 429 响应）。 */
interface RateGateDeny {
  reason: RateGateReason
  tier: Tier
  limit: number
  count: number
  retryAfterSec: number
}

/** 分档闸门结果。 */
interface RateGateResult {
  /** 诊断：闸门内部逐段耗时（ms）——用于定位 D1 往返之外的瓶颈 */
  timings?: Record<string, number>
  tier: Tier
  /** 本次生效的限额（搜索档或 LLM 档） */
  limit: number
  /** 本窗口计数（含本次；D1 不可用为 0） */
  count: number
  /** D1 不可用 → 已 fail-open 放行（调用方已打 warning） */
  degraded: boolean
  /** 元数据采信来源（诊断用） */
  resolvedBy: ClientMetaSource
  /** 全局匿名软熔断：匿名只走关键词回退（不调 embedding/rerank） */
  softBreak: boolean
  /** 非 undefined = 直接返回 429 */
  deny?: RateGateDeny
}

/** 过期计数行的清理间隔（每 N 次受限请求顺手删一批；env `RATE_COUNT_PURGE_EVERY`，默认 200）。 */
function purgeEvery(env: Env): number {
  const n = Number(env.RATE_COUNT_PURGE_EVERY)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200
}

/** 模块级计数（每个 isolate 各自记；只是"顺手清理"的节奏，不需要精确）。 */
let rateOpsSincePurge = 0

/**
 * 顺手清理过期计数行（plan §5：**不引入定时任务**）。
 * 生产走 `c.executionCtx.waitUntil`（不增加请求延迟）；测试环境没有 ExecutionContext 时静默跳过。
 */
function maybePurgeCounters(c: Context<{ Bindings: Env }>, nowMs: number): void {
  rateOpsSincePurge += 1
  if (rateOpsSincePurge < purgeEvery(c.env)) return
  rateOpsSincePurge = 0
  const job = purgeExpiredCounters(c.env.DB, nowMs).catch(() => 0)
  try {
    c.executionCtx.waitUntil(job)
  } catch {
    // 无 ExecutionContext（单测 / 非 Worker 调用）：丢弃这次清理，下次请求再来
  }
}

/**
 * 分档闸门（plan §4/§5/§6 的接线点）：解析真实元数据 → 定档 → D1 原子计数 → 突发/熔断判定。
 *
 * 顺序（**不要改动，除②③之间已明确记录的那次修复**）：
 *   ① 封禁检查（`block_until`，只读一行）—— 突发封禁期内一律 429（**先于计数**，被拒不再占名额）；
 *   ② 突发（10 秒窗口 ≥ `BURST_PER_10S`）—— 429 并封禁 60s（`block_until`）；
 *   ③ 分档计数（search 或 llm 桶，互不占用额度）—— 超限直接 429；
 *   ④ 全局匿名软/硬熔断 —— 只掐匿名，登录用户不受影响。
 * ⚠️ ② 必须在 ③ 之前：突发阈值高于所有档位上限，若放在 ③ 之后，被档位拒绝的请求就**永远进不到**突发层，
 *    突发层 = 死代码（线上实测 40 并发：scope 全为 tier-limit、burst 出现 0 次）。详见 ② 处的长注释。
 *
 * ── 写放大（诚实版，history.md §5 坑 14：D1 免费版 10 万行写/天）──
 * 每条被闸门处理的请求 = 1 次只读（封禁行）+ 2 次原子计数（突发桶 + 分档桶）；
 * 匿名 `/search` 再多 1 次（全局熔断桶）。即：登录 2 写/请求、匿名搜索 3 写/请求。
 * 与 ②③ 交换前相比：**正常流量写入行数完全一致**；只有"档位已耗尽仍在刷"的攻击流量会多写 1 行 burst。
 * 为什么不让突发桶"热了才写"（更省写的做法）：**那样会漏计**——闸门只能在"已经计数很高"时才打开，
 * 而突发桶从 0 开始数，于是突发阈值永远追不上（例如 cn_residential 上限 30/min 时根本触发不了 20/10s）。
 * 正确性优先于省写：突发是"大流量直接崩"这条硬需求的实现（plan §6）。R7 的混合计数（KV 近似 + D1 精确）
 * 是将来省写的正路，不在本次范围。
 *
 * @param opts.loggedIn        是否持有有效会话（true → `logged_in` 档）
 * @param opts.scope           `search`（纯检索）或 `llm`（stream/chat，限额 = ceil(搜索/除数)）
 * @param opts.applyGlobalBreak 是否参与全局匿名熔断（只有匿名可达的路径才需要）
 */
async function rateGate(
  c: Context<{ Bindings: Env }>,
  opts: { loggedIn: boolean; scope: "search" | "llm"; nowMs: number; applyGlobalBreak: boolean },
): Promise<RateGateResult> {
  const { nowMs } = opts
  const cf = (c.req.raw as unknown as { cf?: ClientMetaCf }).cf ?? null
  const meta = resolveClientMeta(c.req.raw.headers, c.env, cf)
  const tier = decideTier({ loggedIn: opts.loggedIn, country: meta.country, asn: meta.asn })
  const limit = opts.scope === "llm" ? llmLimitForTier(tier, c.env) : limitForTier(tier, c.env)
  const base: RateGateResult = { tier, limit, count: 0, degraded: false, resolvedBy: meta.by, softBreak: false }

  const tm: Record<string, number> = {}
  let _t = Date.now()
  const hmacKey = await deriveRateLimitHmacKey(c.env)
  tm.hmac = Date.now() - _t
  if (isDegradedHmacKey(hmacKey)) {
    // 只打一次警告就够，但 isolate 生命周期短，这里每次打也只是 noise 级；**绝不打印密钥**。
    console.warn("[ratelimit] PROXY_SHARED_SECRET 未配置 → 计数桶匿名化强度下降（生产必须配置）")
  }
  if (!c.env.DB) {
    console.warn("[ratelimit] D1 不可用 → 分档计数 fail-open")
    return { ...base, degraded: true }
  }

  // ① 突发封禁检查（硬停）：封禁期内一律 429，且**不再消耗**任何名额
  if (meta.ip) {
    _t = Date.now()
    const blockedUntil = await readBlockUntil(c.env.DB, { hmacKey, ip: meta.ip, tier, nowMs })
    tm.block = Date.now() - _t
    if (blockedUntil > nowMs) {
      return {
        ...base,
        deny: {
          reason: "blocked",
          tier,
          limit,
          count: 0,
          retryAfterSec: Math.max(1, Math.ceil((blockedUntil - nowMs) / 1000)),
        },
      }
    }
  }

  // ② 突发（10 秒窗口）——**必须排在分档计数之前**（2026-09-10 修：原先排在后面 = 死代码）
  //
  // ── 为什么顺序不能反（线上实测 + 代码推理）──
  // 原顺序是「分档计数 → 突发」：② 一旦拒绝就 `return`，被拒的请求**永远进不到**突发层。
  // 而突发阈值 `BURST_PER_10S=20`（=120 次/分钟）高于**所有**档位上限（最高 `logged_in` 60/分钟 = 10 次/10 秒），
  // 也就是说：能进入突发层的请求，其上限已经被档位卡在 10 次/10 秒以下 → 20/10s 永远达不到 → 突发与封禁形同不存在。
  // 线上实测（境外档 10/min）：40 并发 → 10×200 + 30×429，429 的 scope **全部是 tier-limit，burst 出现 0 次**。
  // 修法：把突发计数提到分档之前 → **每一个到达闸门的请求都计入突发桶**（含已被档位拒绝的），
  //       脚本刷量在 20 次/10 秒时触发 → 429(scope=burst) + 封禁 60 秒 → 后续一律 429(scope=blocked)。
  //
  // ── 写放大（诚实版，history.md §5 坑 14）──
  // 这次改动只在「档位已耗尽但仍在刷」的攻击场景下多写 1 行 burst（被拒请求现在也计入突发桶）。
  // 正常流量写入行数与之前**完全一致**（分档桶 + 突发桶 + 匿名全局桶 = 3 行/匿名请求）。
  // **不要**为了省这 1 行而把顺序退回去：那样突发层就是死代码，省下的是攻击者的成本，付掉的是整站的可用性。
  const burstLimit = burstPer10s(c.env)
  if (meta.ip) {
    _t = Date.now()
    const burst = await consumeRateToken(c.env.DB, {
      scope: "burst",
      tier,
      hmacKey,
      ip: meta.ip,
      windowSec: BURST_WINDOW_SEC,
      limit: burstLimit,
      nowMs,
    })
    tm.burst = Date.now() - _t
    if (!burst.ok && !burst.degraded) {
      await writeBlockUntil(c.env.DB, {
        hmacKey,
        ip: meta.ip,
        tier,
        blockUntilMs: nowMs + BURST_BLOCK_SEC * 1000,
        nowMs,
        blockSec: BURST_BLOCK_SEC,
      })
      console.warn(`[ratelimit] 突发触发 → 封禁 ${BURST_BLOCK_SEC}s tier=${tier} burst=${burst.count}/${burstLimit}`)
      return {
        ...base,
        // 分档计数尚未发生 → 这里回显突发桶计数（该字段仅诊断用，不进 429 响应体）
        count: burst.count,
        deny: { reason: "burst", tier, limit, count: burst.count, retryAfterSec: BURST_BLOCK_SEC },
      }
    }
  }

  // ③ 分档计数（D1 原子「判-占」）
  _t = Date.now()
  const res = await consumeRateToken(c.env.DB, {
    scope: opts.scope,
    tier,
    hmacKey,
    ip: meta.ip,
    windowSec: RATE_WINDOW_SEC,
    limit,
    nowMs,
  })
  tm.tier = Date.now() - _t
  maybePurgeCounters(c, nowMs)
  if (res.degraded) console.warn(`[ratelimit] D1 异常 → fail-open scope=${opts.scope} tier=${tier}`)
  if (!res.ok) {
    return {
      ...base,
      count: res.count,
      degraded: res.degraded,
      deny: { reason: "tier-limit", tier, limit, count: res.count, retryAfterSec: res.retryAfterSec },
    }
  }

  // ④ 全局匿名软/硬熔断（只用**一个** global 桶：count ≤ 软阈值 = 正常；
  //    软阈值 < count ≤ 硬阈值 = 只给关键词回退；count > 硬阈值 = 匿名一律 429）
  let softBreak = false
  if (opts.applyGlobalBreak && !opts.loggedIn) {
    const soft = anonGlobalLimit(c.env)
    const hard = anonGlobalHardLimit(c.env)
    _t = Date.now()
    const g = await consumeRateToken(c.env.DB, {
      scope: "global",
      hmacKey,
      windowSec: RATE_WINDOW_SEC,
      limit: hard,
      nowMs,
    })
    if (!g.degraded && !g.ok) {
      console.warn(`[ratelimit] 全局硬熔断触发 → 匿名 429 count=${g.count} hard=${hard}`)
      return {
        ...base,
        count: res.count,
        deny: { reason: "global-hard", tier, limit: hard, count: g.count, retryAfterSec: g.retryAfterSec },
      }
    }
    softBreak = !g.degraded && g.count > soft
    if (softBreak) console.warn(`[ratelimit] 全局软熔断触发 → 匿名仅关键词回退 count=${g.count} soft=${soft}`)
  }

  tm.global = tm.global ?? 0
  return { ...base, count: res.count, softBreak, timings: tm }
}

/**
 * 429 响应（plan §4/§6：`{ error: "rate-limited", tier, retry_after }` + `Retry-After` 头）。
 * 日志**只含**档位/限额/原因 —— 绝不含 IP、绝不含密钥（plan §5 隐私节）。
 */
function rateLimitedResponse(c: Context<{ Bindings: Env }>, deny: RateGateDeny) {
  console.warn(
    `[ratelimit] 429 reason=${deny.reason} tier=${deny.tier} limit=${deny.limit} count=${deny.count} retry_after=${deny.retryAfterSec}s`,
  )
  return c.json(
    { error: "rate-limited", tier: deny.tier, scope: deny.reason, retry_after: deny.retryAfterSec },
    429,
    {
      "Retry-After": String(deny.retryAfterSec),
      "X-RateLimit-Limit": String(deny.limit),
      "X-RateLimit-Remaining": "0",
    },
  )
}

/** 统一的「关键词回退 + 原因 warning」响应。 */
function fallbackResponse(
  fb: FallbackResponse,
  quotaFields: { used_pct: number; remaining_pct: number },
  reason: string,
) {
  return {
    hits: fb.hits,
    timings: { embed_ms: 0, search_ms: 0, rerank_ms: 0, llm_ms: 0, total_ms: 0 },
    quota: { ...quotaFields, fallback: true },
    warnings: [reason],
    fallback: true as const,
    notice: fb.notice,
  }
}

export const app = new Hono<{ Bindings: Env }>()

// ── CORS（沿用旧版思想，搬前端 &work 形式）──
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? "http://localhost,http://127.0.0.1")
        .split(",")
        .map((s: string) => s.trim())
      if (allowed.includes("*")) return origin
      if (allowed.includes(origin)) return origin
      return allowed[0] ?? ""
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

app.onError((err, c) => {
  // 关键：绝不回显 key / secret。错误体只暴露泛化信息。
  console.error(`Unhandled error: ${(err as Error).message ?? String(err)}`)
  return c.json({ error: "internal-error" }, 500)
})

// ── 健康检查 ──
app.get("/healthz", (c) => c.json({ ok: true }))

// ── v1 路由前缀（M0 只做 /api/v1/search 占位 + 其余登记为 not-yet）──
const api = new Hono<{ Bindings: Env }>()

api.get("/corpora", async (c) => {
  // T2.1：每库统计（chunk 数取 Qdrant collection points_count；doc 数与 last_updated 从 D1 最优，
  // 当前无 D1 时归零/null——统计注入点，后续接 D1 ingest_runs 后填真值）。
  const stats = new Map<string, { document_count: number; chunk_count: number; last_updated: string | null }>()
  const qdrantUrl = c.env.QDRANT_URL
  if (qdrantUrl) {
    for (const w of listWikis()) {
      try {
        const resp = await fetch(`${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName(w.id)}`, {
          headers: c.env.QDRANT_API_KEY ? { "api-key": c.env.QDRANT_API_KEY } : {},
        })
        if (resp.ok) {
          const j = (await resp.json()) as { result?: { points_count?: number } }
          stats.set(w.id, { document_count: 0, chunk_count: j.result?.points_count ?? 0, last_updated: null })
        }
      } catch {
        // 单库统计失败忽略，该库保持归零
      }
    }
  }
  return c.json(buildCorporaResponse(stats))
})

// GET /api/v1/tree/:wiki_id —— 知识树（T2.4）：Qdrant scroll → buildTree 聚合。
api.get("/tree/:wiki_id", async (c) => {
  const wikiId = c.req.param("wiki_id")
  if (!isValidCorpus(wikiId)) {
    return c.json({ error: "invalid-corpus" }, 422)
  }
  if (!c.env.QDRANT_URL) {
    return c.json({ error: "qdrant-unconfigured" }, 502)
  }
  try {
    const chunks = await fetchAllChunks(collectionName(wikiId), c.env.QDRANT_URL, c.env.QDRANT_API_KEY, fetch)
    return c.json({ wiki_id: wikiId, tree: buildTree(chunks) })
  } catch (e) {
    if (e instanceof QdrantScrollError) {
      if (e.status === 404) return c.json({ error: "wiki-not-found" }, 404)
      return c.json({ error: "qdrant-unavailable" }, 502)
    }
    throw e
  }
})

// POST /api/v1/search —— 纯向量检索（T0.4）
// ── POST /search（T3.2/T3.3）：限流 → 登录判定 → 配额 → 检索 ──
api.post("/search", async (c) => {
  // 延迟剖析探针：handler 入口时间（用于把"端到端 TTFB"拆成"Worker 内耗时"与"边缘/网络耗时"）
  const tHandler = Date.now()
  let body: Partial<SearchRequest> = {}
  try {
    body = await c.req.json<SearchRequest>()
  } catch {
    // 解析失败：交给 runSearch 的 422 校验
  }
  const req = body as SearchRequest
  const nowMs = Date.now()
  const corporaList = Array.isArray(req.corpora) ? req.corpora : []

  // ⓪ 参数校验先行：非法参数一律 422（不受登录/限流影响）
  try {
    validate(req)
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }

  // ① 限流：未登录按 IP，登录按账号（KV 缺失 fail-open）
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  const ip = clientIpFromHeaders(c.req.raw.headers, c.env)
  const rl = await checkSubjectRateLimit(
    c.env.SEARCH_CACHE ? kvRateLimitStore(c.env.SEARCH_CACHE) : undefined,
    { ip, accountId: session?.sub },
    rateLimitPolicy(c.env),
    nowMs,
  )
  if (rl.degraded) console.warn(`[ratelimit] degraded scope=${rl.scope}`)
  if (!rl.allowed) {
    return c.json({ error: "rate-limited", retry_after: rl.retryAfterSec }, 429, rateLimitHeaders(rl))
  }

  // ①b D1 分档计数（**权威**，plan-ratelimit.md §5）：按真实 country/ASN 定档给额度，
  //     并发突发与全局匿名熔断也在这里判定。D1 不可用 → fail-open（打 warning）。
  const gate = await rateGate(c, { loggedIn: Boolean(session), scope: "search", nowMs, applyGlobalBreak: true })
  const gateMs = Date.now() - tHandler
  if (gate.deny) return rateLimitedResponse(c, gate.deny)

  // ② 未登录：按 plan §2 登录制只走关键词回退（REQUIRE_LOGIN=0 可放开）；
  //    若全局匿名软熔断生效（§6），**即使放开了登录制也只给关键词回退**（不调 embedding/rerank，成本≈0）。
  if (!session && (requireLogin(c.env) || gate.softBreak)) {
    const fb = await runFallback(req.query ?? "", corporaList, c.env)
    return c.json(
      fallbackResponse(
        fb,
        { used_pct: 0, remaining_pct: 100 },
        gate.softBreak ? "global-soft-break" : "login-required",
      ),
    )
  }

  // ③ 登录：先扣配额（D1 原子批）：窗口对齐 + 判-扣-计数 + 回读在**一次往返**里完成（见 quota.ts）
  const tQuota = Date.now()
  let chargeResult: Awaited<ReturnType<typeof chargeQuota>> | null = null
  if (session) {
    const cost = computeQuotaCost({ search: true, rerank: req.use_reranker !== false })
    const charge = await chargeQuota(c.env.DB, session.sub, cost, nowMs, c.env)
    chargeResult = charge
    if (!charge.ok && charge.reason === "quota-exceeded") {
      const fb = await runFallback(req.query ?? "", corporaList, c.env)
      return c.json(
        fallbackResponse(fb, { used_pct: charge.used_pct, remaining_pct: charge.remaining_pct }, "quota-exceeded"),
      )
    }
    if (!charge.ok) console.warn("[quota] db-unavailable → fail-open")
  }

  // ④ 检索（T3.3：先取 admin 下架集合，fail-open 传给工厂）
  try {
    const result = await runSearch(req, c.env, {
      denied: await loadDeniedKeys(c.env),
      // 账号作用域的用量记账：embedding / rerank 的每次上游调用都落 key_usage.account_id
      // （匿名 = 空串，仍记账；只是不归属任何账号）。不改检索语义。
      db: makeKeyUsageDb(c.env, session?.sub),
    })
    const diag = {
      gate_ms: gateMs,
      ...Object.fromEntries(Object.entries(gate.timings ?? {}).map(([k, v]) => [`gate_${k}_ms`, v])),
      quota_ms: session ? Date.now() - tQuota : 0,
      handler_ms: Date.now() - tHandler,
    }
    // 注：`RunSearchResult` 是联合类型，`FallbackResponse` 的类型里没声明 `timings`，
    // 但运行时它一定带（见 fallbackResponse 构造）→ 统一按 SearchResponse 取用。
    const sr = result as SearchResponse
    if (!session) return c.json({ ...sr, timings: { ...sr.timings, ...diag } })
    // 配额视图**复用扣费时同事务回读的结果**（`charge.view`），不再为响应单独查一次 D1。
    // 只有"扣费走了 db-unavailable 兜底"这种罕见情况才回退到一次 getQuota（那时视图本来就是"放行视图"）。
    const view = chargeResult?.view ?? (await getQuota(c.env.DB, session.sub, nowMs, c.env))
    const fb = Boolean(sr.fallback)
    return c.json({
      ...sr,
      timings: { ...sr.timings, ...diag },
      quota: toQuotaResponse(view, fb),
    })
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }
})

// 其余 v1 路由：M0 统一登记为未实现占位，标注各自预期实现任务
// ── 登录（T3.1）：X OAuth 2.0 + PKCE ──
// GET /auth/oauth/x/start → 302 到 X 授权页（state/verifier 存 KV）
api.get("/auth/oauth/x/start", async (c) => {
  try {
    const { url } = await startXLogin(c.env, c.req.query("redirect"))
    return c.redirect(url, 302)
  } catch (e) {
    if (e instanceof AuthConfigError) return c.json({ error: (e as Error).message }, 503)
    return c.json({ error: "oauth-start-failed" }, 502)
  }
})

// GET /auth/oauth/x/callback → 换 token、取用户、建号、签 JWT，302 回前端（token 放 fragment）
api.get("/auth/oauth/x/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")
  const fail = (reason: string) =>
    c.redirect(`${frontendBase(c.env)}/login/#error=${encodeURIComponent(reason)}`, 302)

  if (!code || !state) return fail("missing-code-or-state")
  if (!c.env.DB) return fail("db-unconfigured")

  try {
    const { xId, handle, redirectAfter } = await exchangeXCode(c.env, code, state)
    const acc = await upsertXAccount(c.env.DB, c.env, xId, handle, Date.now())
    if (acc.status === "banned") return fail("account-banned")
    const token = await issueSession(c.env, { sub: acc.account_id, handle: acc.handle, role: acc.role })
    return c.redirect(loginRedirectUrl(c.env, redirectAfter, token), 302)
  } catch (e) {
    // 不回显任何密钥/原始响应；只给泛化原因
    return fail((e as Error)?.message?.slice(0, 60) ?? "oauth-callback-failed")
  }
})

api.post("/auth/bind/email", (c) => c.json({ error: "not-yet" }, 501)) // 邮箱绑定已砍（T3.7 取消）

// GET /me → 当前账号 + 配额（需 Authorization: Bearer <JWT>）
api.get("/me", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  // `disclaimer_ack_at` 由 SCHEMA_MIGRATIONS 补列。部署后若还没跑 apply-schema（旧库没有该列），
  // 带它的查询会报 `no such column` —— 那时**退化为旧查询**（确认态视为未确认，最多少弹一次提示），
  // 绝不让 /me 500（那会让顶栏账号区整块报错，比"多弹一次弹窗"严重得多）。
  // 退化查询自身再失败（真·DB 故障）→ 照旧向上抛（500），不假装成"账号不存在"。
  const acc = await (async () => {
    try {
      return await c.env.DB!.prepare("SELECT status, created_at, disclaimer_ack_at FROM accounts WHERE id = ?")
        .bind(session.sub)
        .first<{ status: string; created_at: number; disclaimer_ack_at: number | null }>()
    } catch {
      const legacy = await c.env.DB!.prepare("SELECT status, created_at FROM accounts WHERE id = ?")
        .bind(session.sub)
        .first<{ status: string; created_at: number }>()
      return legacy ? { ...legacy, disclaimer_ack_at: null } : null
    }
  })()
  if (!acc) return c.json({ error: "account-not-found" }, 404)
  if (acc.status !== "active") return c.json({ error: "account-" + acc.status }, 403)

  const quota = await getQuota(c.env.DB, session.sub, Date.now(), c.env)
  // 免责声明同意态（前端 DisclaimerDialog 据此决定"登录用户已确认过就不再弹"）：
  //   · `disclaimer_ack_at` 毫秒时间戳，NULL = 从未确认；
  //   · `disclaimer_ack` 是它的布尔投影，前端判空更方便（老部署无该字段 → undefined → 视为未确认）。
  const ackAt = typeof acc.disclaimer_ack_at === "number" && Number.isFinite(acc.disclaimer_ack_at) ? acc.disclaimer_ack_at : null
  return c.json({
    // handle 来自会话 JWT（DB 不存 X 明文，见 auth.ts 隐私注释）
    user: { account_id: session.sub, handle: session.handle, role: session.role, created_at: acc.created_at },
    quota,
    quota_display: formatPct(quota.used_pct),
    disclaimer_ack_at: ackAt,
    disclaimer_ack: ackAt !== null,
  })
})

// POST /me/disclaimer → 记录/撤销"免责声明已确认"（需 Authorization: Bearer <JWT>）
//   body: { ack?: boolean }   缺省 true
//     · ack=true  → disclaimer_ack_at = now（前端"我知道了，不再提示"）
//     · ack=false → disclaimer_ack_at = NULL（前端设置页"启动时显示免责提示"重新打开）
// 返回：{ ok: true, disclaimer_ack_at }（写库后的真值，认 number|null）
// 语义说明：**只影响"是否再弹窗"这一件事**，与配额/限流/账号状态无关；重复调用幂等（true 会刷新时间戳）。
// 注意：不经过分档限流闸门（与 /me、/settings/models 同级：登录态的元数据读写，不产生上游成本）。
api.post("/me/disclaimer", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  // body 可选：空 body 视为 `{}`（= ack 缺省 true，方便 `curl -X POST` 直接确认）；
  // 非空但解析失败 / 解析出来不是对象（数组、字符串、null）→ 422，绝不猜用户意图。
  const rawText = await c.req.text().catch(() => "")
  let body: unknown = {}
  if (rawText.trim() !== "") {
    try {
      body = JSON.parse(rawText)
    } catch {
      return c.json({ error: "invalid-body" }, 422)
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "invalid-body" }, 422)
  const ackRaw = (body as { ack?: unknown }).ack
  if (ackRaw !== undefined && typeof ackRaw !== "boolean") return c.json({ error: "invalid-ack" }, 422)
  const ack = ackRaw === undefined ? true : ackRaw

  const ackAt = ack ? Date.now() : null
  try {
    const res = await c.env.DB.prepare("UPDATE accounts SET disclaimer_ack_at = ? WHERE id = ?")
      .bind(ackAt, session.sub)
      .run()
    // changes === 0：账号行不存在（会话有效但账号被删）→ 404，别让前端以为已经记住了
    if (res?.meta?.changes !== 1) return c.json({ error: "account-not-found" }, 404)
  } catch {
    return c.json({ error: "db-unavailable" }, 503)
  }
  return c.json({ ok: true, disclaimer_ack_at: ackAt })
})

// ── POST /search/stream（T3.4）：SSE 流式 AI 总结 ──
api.post("/search/stream", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)

  // LLM 档限流（plan §4.0：限额 = ceil(搜索限额 / RATE_LIMIT_LLM_DIVISOR)，与搜索**分开计数**）。
  // 放在配额扣减之前：被限流的请求不该消耗用户额度。
  const gate = await rateGate(c, {
    loggedIn: true,
    scope: "llm",
    nowMs: Date.now(),
    applyGlobalBreak: false, // 全局熔断只掐匿名，登录用户不受影响（§6）
  })
  if (gate.deny) return rateLimitedResponse(c, gate.deny)

  let body: Partial<SearchRequest> = {}
  try {
    body = await c.req.json<SearchRequest>()
  } catch {
    /* 交给 runSearch 校验 */
  }
  const req = body as SearchRequest
  const nowMs = Date.now()

  // 搜索部分先扣额度
  const cost = computeQuotaCost({ search: true, rerank: req.use_reranker !== false })
  const charge = await chargeQuota(c.env.DB, session.sub, cost, nowMs, c.env)
  if (!charge.ok && charge.reason === "quota-exceeded") {
    return c.json(
      { error: "quota-exceeded", quota: { used_pct: charge.used_pct, remaining_pct: charge.remaining_pct } },
      429,
    )
  }

  let result: SearchResponse
  // T3.3 运行时效：禁用集合只影响 KeyPool 选 key，不改检索语义（fail-open）
  const denied = await loadDeniedKeys(c.env)
  try {
    result = (await runSearch({ ...req, use_llm: false }, c.env, {
      denied,
      db: makeKeyUsageDb(c.env, session.sub),
    })) as SearchResponse
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }

  const question = (req.query ?? "").trim()
  const llmHits = toLlmHits(result.hits ?? [])
  const wantLlm = req.use_llm === true
  const enc = new TextEncoder()
  const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 复用扣费时同事务回读的视图（原来在流内单独 getQuota = 多 1~2 次往返）
        const view = charge.view ?? (await getQuota(c.env.DB, session.sub, nowMs, c.env))
        controller.enqueue(
          sse("hits", {
            hits: result.hits,
            timings: result.timings,
            quota: toQuotaResponse(view, Boolean(result.fallback)),
            fallback: result.fallback,
          }),
        )
        if (!wantLlm) {
          controller.enqueue(sse("done", { llm: false }))
          return
        }

        const ctx = await createSession(
          c.env.DB,
          session.sub,
          req.model_id ?? "default",
          Array.isArray(req.corpora) ? req.corpora : [],
          llmHits,
          Date.now(),
        )
        if (ctx) controller.enqueue(sse("session", { session_id: ctx.id, max_rounds: 10 }))

        const chat = chatProviderFor(c.env, session.sub)
        applyDeniedToPool(chat.pool, denied, "llm")
        const llm = chat.provider.streamSummary(llmHits, question)
        controller.enqueue(sse("citations", { citations: llm.citations, model: llm.model }))
        let text = ""
        for await (const delta of llm) {
          text += delta
          controller.enqueue(sse("delta", { text: delta }))
        }
        let usage: LlmUsage | null = null
        try {
          usage = await llm.usage
        } catch {
          /* 用量结算失败不阻断 */
        }
        if (ctx && text) await appendRound(c.env.DB, ctx.id, "assistant", text, Date.now())
        if (usage) {
          await chargeQuota(
            c.env.DB,
            session.sub,
            computeQuotaCost({ llmTokens: usage.tokens_in + usage.tokens_out }),
            Date.now(),
            c.env,
          )
        }
        controller.enqueue(sse("done", { llm: true, model: llm.model, usage }))
      } catch (e) {
        const code = isLlmUnavailable(e) ? e.code : "llm-upstream"
        controller.enqueue(sse("error", { code, notice: LLM_UNAVAILABLE_NOTICE }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
})

// ── POST /chat（T3.4 多轮追问）──
api.post("/chat", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)

  // LLM 档限流（与 /search/stream 同一个 `llm` 桶；与搜索桶分开计数，互不占用额度）
  const gate = await rateGate(c, {
    loggedIn: true,
    scope: "llm",
    nowMs: Date.now(),
    applyGlobalBreak: false, // 全局熔断只掐匿名（§6）
  })
  if (gate.deny) return rateLimitedResponse(c, gate.deny)

  let body: { session_id?: string; question?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    /* 下面 422 */
  }
  const sessionId = (body.session_id ?? "").trim()
  const question = (body.question ?? "").trim()
  if (!sessionId || !question) return c.json({ error: "session_id-and-question-required" }, 422)

  const ctx = await loadContext(c.env.DB, sessionId)
  if (!ctx) return c.json({ error: "session-not-found" }, 404)
  if (ctx.accountId !== session.sub) return c.json({ error: "forbidden" }, 403)
  if (isMaxRounds(ctx)) return c.json({ error: "max-rounds", notice: "已满 10 轮，请开新会话" }, 409)

  const appended = await appendRound(c.env.DB, sessionId, "user", question, Date.now())
  if (!appended.ok) return c.json({ error: appended.reason }, appended.reason === "max-rounds" ? 409 : 400)

  const history: ChatMessage[] = historyToMessages(ctx.history)
  try {
    if (ctx.modelId && ctx.modelId !== "default") {
      // T3.5：用户自带模型逃生通道
      const loaded = await loadCustomModel(c.env.DB, c.env, session.sub, ctx.modelId)
      if (!loaded.ok) return c.json({ error: loaded.code, reason: loaded.reason }, 502)
      const built = buildPrompt(ctx.initialHits, question, history)
      const out = await callCustomModel(loaded.config, built.messages)
      await appendRound(c.env.DB, sessionId, "assistant", out.text, Date.now())
      await chargeQuota(
        c.env.DB,
        session.sub,
        computeQuotaCost({ llmTokens: out.tokens_in + out.tokens_out }),
        Date.now(),
        c.env,
      )
      return c.json({
        text: out.text,
        citations: built.citations,
        model: out.model,
        tokens_in: out.tokens_in,
        tokens_out: out.tokens_out,
        estimated: out.estimated,
      })
    }

    const chat = chatProviderFor(c.env, session.sub)
    applyDeniedToPool(chat.pool, await loadDeniedKeys(c.env), "llm")
    const out = await chat.provider.summarize(ctx.initialHits, question, { history })
    await appendRound(c.env.DB, sessionId, "assistant", out.text, Date.now())
    await chargeQuota(
      c.env.DB,
      session.sub,
      computeQuotaCost({ llmTokens: out.tokens_in + out.tokens_out }),
      Date.now(),
      c.env,
    )
    return c.json({
      text: out.text,
      citations: out.citations,
      model: out.model,
      tokens_in: out.tokens_in,
      tokens_out: out.tokens_out,
      estimated: out.estimated,
    })
  } catch (e) {
    if (isLlmUnavailable(e)) {
      return c.json({ error: e.code, notice: LLM_UNAVAILABLE_NOTICE, hits: ctx.initialHits }, 503)
    }
    throw e
  }
})

// ── /settings/models（T3.5 自定义模型，仅本人）──
api.get("/settings/models", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  return c.json({ models: await listCustomModels(c.env.DB, session.sub) })
})

api.post("/settings/models", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  let body: { id?: string; name?: string; base_url?: string; model?: string; api_key?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const saved = await saveCustomModel(
    c.env.DB,
    c.env,
    session.sub,
    { name: body.name ?? "", base_url: body.base_url ?? "", model: body.model ?? "", api_key: body.api_key },
    Date.now(),
    body.id,
  )
  if (!saved.ok) {
    const status = saved.code === "db-unavailable" || saved.code === "enc-key-missing" ? 503 : 422
    return c.json({ error: saved.code, reason: saved.reason }, status)
  }
  return c.json({ model: saved.model })
})

// DELETE /settings/models/:id —— 删除本人自定义模型（越权/不存在 → 404）
api.delete("/settings/models/:id", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  const deleted = await deleteCustomModel(c.env.DB, session.sub, c.req.param("id"))
  if (!deleted.ok) {
    return c.json({ error: deleted.code, reason: deleted.reason }, deleted.code === "db-unavailable" ? 503 : 404)
  }
  return c.json({ ok: true, deleted: deleted.deleted })
})

/**
 * admin 路由统一鉴权（T3.3 + T3.6 扩展）：**二选一，任一通过即放行**
 *   ① `Authorization: Bearer <ADMIN_API_KEY>` —— 运维通道（curl / CI），行为与旧版完全一致；
 *   ② `Authorization: Bearer <JWT>` 且会话 `role === "admin"` —— 前端管理页通道
 *      （用 `sessionFromHeader()`，与 /me 同一套校验）。
 * 未通过 → 401 `{error:"unauthorized"}`（**不再**因为没有 ADMIN_API_KEY 就 503：
 * 只配了 JWT 的部署也必须能用管理页）。ADMIN_API_KEY 未配置 + JWT 非 admin → 同样 401。
 * 注意：这里不查账号封禁状态（JWT 已签名的 admin 视为可信；封禁的是「使用检索」而非「被审计」）。
 * 返回 `actorId`：审计用，`?actor=` 优先（旧运维习惯），其次 JWT 的 account_id，最后 "admin"。
 */
async function adminAuthorize(
  c: Context<{ Bindings: Env }>,
): Promise<{ denied: Response | null; actorId: string }> {
  const header = c.req.header("Authorization") ?? ""
  const actorParam = c.req.query("actor") ?? ""
  const key = c.env.ADMIN_API_KEY
  if (key && header === `Bearer ${key}`) {
    return { denied: null, actorId: actorParam || "admin" }
  }
  try {
    const session = await sessionFromHeader(c.env, header)
    if (session?.role === "admin") {
      return { denied: null, actorId: actorParam || session.sub }
    }
  } catch {
    // JWT 校验异常一律视为未通过（不 500、不回显任何细节）
  }
  return { denied: Response.json({ error: "unauthorized" }, { status: 401 }), actorId: "" }
}

// ── GET /admin/usage —— 只读用量总览（T3.3 / T3.6 /admin 页）──
//   数据：accounts + quotas（period_start=window_start、used_cost=used_tokens）+ provider_keys 脱敏投影。
//   额度/窗口长度来自 limitTokens(env)/windowHours(env)（见 src/quota.ts），不读 DB 的 monthly_limit。
//   绝不返回任何 secret：keys[] 只有 key_ref / 计数 / 成本（见 keyadmin.ts）。
api.get("/admin/usage", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  try {
    return c.json(await buildAdminUsage(c.env.DB, c.env, Date.now()))
  } catch {
    // 不把 SQL 细节回显给客户端；日志只留泛化信息。
    console.warn("[admin] usage aggregation failed")
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ── GET /admin/ratelimit —— 分档限流观测（plan-ratelimit.md §10 R5 / §11 验收）──
//   数据面：**只读聚合** `rate_counters` 现有行（见 src/ratecount.ts 的只读聚合段），
//   口径 = 当前窗口 + 上一个窗口（`window_start >= range_start` 走 idx_rate_counters_window，非全表扫描）。
//   ⚠️ 本路由**绝不写库**（匿名搜索已是 3 行写/请求，不能再加）：只有两条 SELECT。
//   隐私：只回聚合数，**没有 IP、没有 bucket_key**（表里本来就没有 IP 列）。
//   失败语义：缺 D1 → 503 db-unconfigured；读失败 → 503 db-unavailable（与 /admin/usage 同款）。
api.get("/admin/ratelimit", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  try {
    // 与 rateGate 同一个派生函数 → 面板显示的就是线上实际生效的降级状态（只回布尔，绝不回密钥）
    const hmacKey = await deriveRateLimitHmacKey(c.env)
    return c.json(
      await buildRateLimitStats(c.env.DB, c.env, Date.now(), { hmacDegraded: isDegradedHmacKey(hmacKey) }),
    )
  } catch {
    console.warn("[admin] ratelimit aggregation failed")
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ── GET /admin/keys —— 只读 key 池健康（T3.3「keys 上架禁用 + 每 key 用量」）──
//   keys[]：provider_keys 行（**只有 key_ref**，绝无 secret）；pools[]：env 池的 ref 清单（parsePoolKeys 推导）。
//   D1 缺失 → 仍 200：pools 来自 env secrets，不依赖 D1（keys:[] / db_rows:0），运维仍能看到池配置。
api.get("/admin/keys", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  const pools = buildPoolInfos(c.env)
  if (!c.env.DB) return c.json({ keys: [], pools, db_rows: 0 })
  try {
    const keys = await fetchProviderKeyRows(c.env.DB)
    return c.json({ keys, pools, db_rows: keys.length })
  } catch {
    console.warn("[admin] provider_keys read failed")
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ── POST /admin/keys —— 上架/禁用一把 key（T3.3）──
//   ① provider_keys upsert（enabled）；② 写审计（action=key_enable|key_disable，target 只放 key_ref）；
//   ③ 运行时效：KV `keydeny:<pool>` 记录禁用集合，KeyPool 取用时剔除（KV 故障 = fail-open，不阻断）。
//   请求体 `{ key_ref: "llm-key-0", pool: "llm", enabled: false }`（enabled 缺省 = true 上架）。
api.post("/admin/keys", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied

  let body: { key_ref?: unknown; pool?: unknown; enabled?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const keyRef = typeof body.key_ref === "string" ? body.key_ref.trim() : ""
  const poolRaw = typeof body.pool === "string" ? body.pool.trim() : ""
  // 形状校验：只接受 `<pool>-key-<n>`，真 key（sk-…）无法进来（见 keyadmin.isSafeKeyRef）
  if (!isSafeKeyRef(keyRef)) return c.json({ error: "invalid-key-ref" }, 422)
  if (!isPoolName(poolRaw)) return c.json({ error: "invalid-pool" }, 422)
  const pool = poolRaw
  const enabled = body.enabled !== false

  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  const nowMs = Date.now()
  try {
    await upsertProviderKey(c.env.DB, { pool, keyRef, enabled, nowMs })
  } catch {
    console.warn("[admin] provider_keys upsert failed")
    return c.json({ error: "db-unavailable" }, 503)
  }

  // 审计（旁路；失败不阻断 —— writeAudit 自身也不抛错）。target 只放 key_ref，绝不放真 key。
  const auditWritten = await writeAudit(c.env.DB, {
    actorId: auth.actorId,
    action: enabled ? "key_enable" : "key_disable",
    target: keyRef,
    detail: `pool=${pool}`,
    nowMs,
  })

  // 运行时效（fail-open）：KV 缺失/读写失败 → runtime_applied:false，请求仍 200。
  const runtime = await setKeyDenied(kvDenyStore(c.env.SEARCH_CACHE), pool, keyRef, enabled)
  const configured = poolRefsFromEnv(c.env, pool).includes(keyRef)
  return c.json({
    ok: true,
    key_ref: keyRef,
    pool,
    enabled,
    /** 该 ref 是否真在 env 池里配置（false = 预登记/疑似笔误；不阻断，避免先禁后配的死锁） */
    configured,
    /** KV 里的禁用集合（写入后的真值；KV 不可用时为空数组） */
    disabled_refs: runtime.refs,
    /** 运行时效是否生效（KV 不可用/写失败 → false，此时只有 DB 记了禁用） */
    runtime_applied: runtime.ok,
    audit_written: auditWritten,
  })
})

// POST /admin/accounts/:id/ban —— 封禁/解封（?unban=1 解封）
api.post("/admin/accounts/:id/ban", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const target = c.req.param("id")
  const actorId = auth.actorId
  const reason = c.req.query("reason") ?? "admin-ban"
  const banned = c.req.query("unban") !== "1"
  await c.env.DB.prepare("UPDATE accounts SET status = ? WHERE id = ?")
    .bind(banned ? "banned" : "active", target)
    .run()
  await writeAudit(c.env.DB, {
    actorId,
    action: banned ? "ban" : "unban",
    target,
    detail: `reason=${reason}`,
    nowMs: Date.now(),
  })
  return c.json({ ok: true, status: banned ? "banned" : "active" })
})

// POST /admin/accounts/:id/quota —— 加额/扣额/重置当前窗口
api.post("/admin/accounts/:id/quota", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const target = c.req.param("id")
  const actorId = auth.actorId
  const nowMs = Date.now()
  let body: { delta_tokens?: number; reset?: boolean } = {}
  try {
    body = await c.req.json()
  } catch {
    /* 默认按 0 处理 */
  }

  if (body.reset) {
    const view = await resetQuota(c.env.DB, target, nowMs, c.env)
    if (!view) return c.json({ error: "db-unavailable" }, 503)
    await writeAudit(c.env.DB, { actorId, action: "reset_quota", target, detail: "reset-current-window", nowMs })
    return c.json({ ok: true, quota: view, quota_display: formatPct(view.used_pct) })
  }

  const delta = Number.isFinite(body.delta_tokens) ? Number(body.delta_tokens) : 0
  const view = await grantQuota(c.env.DB, target, delta, nowMs, c.env)
  if (!view) return c.json({ error: "db-unavailable" }, 503)
  await writeAudit(c.env.DB, {
    actorId,
    action: delta >= 0 ? "grant_quota" : "revoke_quota",
    target,
    detail: `delta_tokens=${delta}`,
    nowMs,
  })
  return c.json({ ok: true, quota: view, quota_display: formatPct(view.used_pct) })
})

// GET /admin/d1bench —— 【临时诊断】直接量 D1 的读/写/批成本（用于定位延迟瓶颈；定位完可删）
api.get("/admin/d1bench", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  const db = c.env.DB
  const out: Record<string, number> = {}
  const t = () => Date.now()
  const key = `bench:${Date.now()}`

  let t0 = t()
  for (let i = 0; i < 3; i++) await db.prepare("SELECT 1 AS x").first()
  out["3_sequential_reads_ms"] = t() - t0

  t0 = t()
  await db.batch([db.prepare("SELECT 1 AS x"), db.prepare("SELECT 1 AS x"), db.prepare("SELECT 1 AS x")])
  out["1_batch_of_3_reads_ms"] = t() - t0

  t0 = t()
  await db
    .prepare(
      "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
    )
    .bind(key, "bench", 0, 60, Date.now())
    .run()
  out["1_insert_ms"] = t() - t0

  t0 = t()
  await db
    .batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO rate_counters (bucket_key, tier, window_start, window_sec, count, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
        )
        .bind(key, "bench", 0, 60, Date.now()),
      db
        .prepare("UPDATE rate_counters SET count = count + 1, updated_at = ? WHERE bucket_key = ? AND count < ?")
        .bind(Date.now(), key, 100),
      db.prepare("SELECT count FROM rate_counters WHERE bucket_key = ?").bind(key),
    ])
  out["1_batch_insert_update_select_ms"] = t() - t0

  t0 = t()
  await db.prepare("SELECT count FROM rate_counters WHERE bucket_key = ?").bind(key).first()
  out["1_read_ms"] = t() - t0

  await db.prepare("DELETE FROM rate_counters WHERE bucket_key = ?").bind(key).run()

  // KV 成本（限流器、key 禁用集、检索缓存都走 KV）
  if (c.env.SEARCH_CACHE) {
    const kv = c.env.SEARCH_CACHE
    const kvKey = `bench:kv:${Date.now()}`
    t0 = t()
    await kv.get(kvKey)
    out["k v_get_miss_ms"] = t() - t0
    t0 = t()
    await kv.put(kvKey, "1", { expirationTtl: 60 })
    out["kv_put_ms"] = t() - t0
    t0 = t()
    await kv.get(kvKey)
    out["kv_get_hit_ms"] = t() - t0
    t0 = t()
    for (let i = 0; i < 3; i++) await kv.get(kvKey)
    out["3_sequential_kv_gets_ms"] = t() - t0
  }
  return c.json(out)
})

// GET /admin/whoami —— 诊断：看 Worker 到底收到了哪些「来源相关」请求头
// 用途：经 Pages Function 反代后，判断客户端 IP 是否还能被正确识别（限流依赖它，见 TODO.md P0 / R2）。
// 安全：需 admin 鉴权；只回白名单头，绝不回 Authorization / Cookie / **任何密钥**。
//       `x-prism-proxy` 是共享密钥，因此**只回布尔**（是否存在 / 是否匹配），永不回值。
api.get("/admin/whoami", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied

  const h = c.req.raw.headers
  const pick = (name: string): string | null => h.get(name)
  // 代理凭据：只判「有没有」和「配没配上、对不对」，绝不回显值（回显等于把密钥发到浏览器）。
  const secret = typeof c.env.PROXY_SHARED_SECRET === "string" ? c.env.PROXY_SHARED_SECRET : ""
  const proxyHeader = pick(PROXY_SECRET_HEADER)
  const proxyPresent = proxyHeader !== null && proxyHeader.trim().length > 0
  const proxyTrusted = secret.length > 0 && proxyHeader !== null && timingSafeEqualString(proxyHeader, secret)
  // 后端实际会用于限流的取值（与 /search 走**同一个**函数，保证诊断结论与线上行为一致）
  const resolved = resolveClientIp(h, c.env)

  // ── 分档诊断（plan-ratelimit.md §4/§5/§6 的线上验收关键位）──
  // 与 /search 走**同一条**信任链与同一个 decideTier，所以这里看到的 tier = 线上实际生效的档位。
  // 安全：只回档位/限额/计数（**没有密钥、没有 IP 以外的隐私**）；桶名是 HMAC 摘要，**不回显桶 key**。
  const cfMeta = (c.req.raw as unknown as { cf?: ClientMetaCf }).cf ?? null
  const meta = resolveClientMeta(h, c.env, cfMeta)
  // whoami 一般用 ADMIN_API_KEY 调用（无 JWT）→ loggedIn=false，于是 tier 反映的是**匿名**视角的档位，
  // 正是"我这个 IP 会被怎么限流"的答案；带 Bearer JWT 调时才是登录档。
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  const tier = decideTier({ loggedIn: Boolean(session), country: meta.country, asn: meta.asn })
  const nowMs = Date.now()
  const hmacKey = await deriveRateLimitHmacKey(c.env)
  const peek = await peekRateCount(c.env.DB, {
    scope: "search",
    tier,
    hmacKey,
    ip: meta.ip,
    windowSec: RATE_WINDOW_SEC,
    nowMs,
  })

  return c.json({
    ok: true,
    // 只看这些「谁在调用我」相关的头
    "cf-connecting-ip": pick("cf-connecting-ip"),
    "x-forwarded-for": pick("x-forwarded-for"),
    "x-real-ip": pick("x-real-ip"),
    "x-prism-client-ip": pick(PROXY_CLIENT_IP_HEADER),
    "cf-ray": pick("cf-ray"),
    "cf-ipcountry": pick("cf-ipcountry"),
    "user-agent-length": (pick("user-agent") ?? "").length,
    origin: pick("origin"),
    host: pick("host"),
    // 代理信任链的诊断位（全是布尔，不泄漏密钥）：
    /** 请求上是否带了 `x-prism-proxy` 头（无论值对不对）——false = 头根本没到 */
    "x-prism-proxy-present": proxyPresent,
    /** 该头是否与 `PROXY_SHARED_SECRET` 完全匹配（= 已采信代理声明的 IP）——false 而 present=true = 两边密钥不一致 */
    "x-prism-proxy-trusted": proxyTrusted,
    /** 本 Worker 是否配了 `PROXY_SHARED_SECRET`——false = 未配置，退化为直连逻辑（ip 可能取到 CF 内部地址） */
    "proxy-secret-configured": secret.length > 0,
    // 后端实际会用于限流的取值（复现 clientIpFromHeaders 的信任链）
    resolved_ip: resolved.ip ?? null,
    resolved_by: resolved.by,
    // 经代理转发的**真实客户端**网络元数据（Worker 自己的 request.cf 是子请求的，不可用）
    "x-prism-country": pick("x-prism-country"),
    "x-prism-asn": pick("x-prism-asn"),
    "x-prism-colo": pick("x-prism-colo"),
    // ── 分档限流（plan §4）：实际采信的元数据 + 落到的档位 + 该档限额 ──
    /** 元数据采信来源：proxy-trusted（代理转发）/ cf（直连 request.cf）/ none（取不到） */
    resolved_meta_by: meta.by,
    /** 实际用于分档的 country（归一化后；非信任来源的 x-prism-* 不会被采信） */
    resolved_country: meta.country ?? null,
    /** 实际用于分档的 ASN（归一化后） */
    resolved_asn: meta.asn ?? null,
    /** 该 ASN 是否在「已知境外云/托管」清单里（诊断用，不参与分档） */
    hosting_asn: isKnownHostingAsn(meta.asn ?? undefined),
    /** 本次请求的档位（/search 会用的就是它） */
    tier,
    /** 该档搜索限额（次/分钟） */
    limit_per_min: limitForTier(tier, c.env),
    /** 该档 LLM 限额（次/分钟 = ceil(搜索/除数)） */
    llm_limit_per_min: llmLimitForTier(tier, c.env),
    /** 当前窗口（60s）内该桶已计数（**只读，不占名额**） */
    count_in_window: peek.count,
    /** 计数窗口长度（秒） */
    rate_window_sec: RATE_WINDOW_SEC,
    /** D1 不可用 / 计数不可读 → true（此时限流 fail-open） */
    rate_count_degraded: peek.degraded,
    /** 计数桶 HMAC 密钥是否退化为公开常量（= 未配 PROXY_SHARED_SECRET；**只回布尔**） */
    rate_hmac_degraded: isDegradedHmacKey(hmacKey),
    /** 熔断阈值（便于线上核对 env 是否生效） */
    burst_per_10s: burstPer10s(c.env),
    anon_global_per_min: anonGlobalLimit(c.env),
    anon_global_hard_per_min: anonGlobalHardLimit(c.env),
    // CF 的网络元数据：用于「按 IP 分档限流」判断家宽 / 机房 / 境外（见 TODO.md P0）
    // 注意：这些字段是 CF 在边缘根据连接判定的，**不可伪造**；我们只用它们做分档，不落库。
    // ⚠️ 经 Pages 反代时这里是**子请求自己的**元数据（实测 asn=13335 Cloudflare），真实值见上面的 resolved_*。
    cf: (() => {
      const meta2 = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf ?? {}
      return {
        country: meta2.country ?? null,
        asn: meta2.asn ?? null,
        asOrganization: meta2.asOrganization ?? null,
        colo: meta2.colo ?? null,
        city: meta2.city ?? null,
        region: meta2.region ?? null,
      }
    })(),
  })
})

// POST /admin/db/apply-schema —— 幂等应用 D1 schema
// 用途：受限环境（wrangler d1 execute 不可用）下，用 Worker 的 D1 binding 完成建表/迁移。
// 安全性：只执行 src/db/schemaStatements.ts 中固定的语句（建表 + 迁移），不接受任意 SQL；
//         鉴权同其它 admin 路由（ADMIN_API_KEY 或 JWT role=admin）。
// 顺序：**迁移语句（SCHEMA_MIGRATIONS）先跑，再跑幂等建表（SCHEMA_STATEMENTS）**——
//       线上已存在的 key_usage 需要先补出 account_id 列，后面的
//       `CREATE INDEX ... idx_key_usage_account_created` 才不会 no such column。
// 容错：`isToleratedSchemaError()` 把「其实已经是对的状态」的报错视为成功（applied + tolerated）：
//       · duplicate column name（列已存在：新库/已迁移）
//       · ALTER TABLE 报 no such table（全新库，随后 CREATE TABLE 自带该列）
//       其余错误仍进 failed（响应 207），保证「假绿」不会掩盖真正的迁移失败。
api.post("/admin/db/apply-schema", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const statements = [...SCHEMA_MIGRATIONS, ...SCHEMA_STATEMENTS]
  const applied: string[] = []
  const tolerated: Array<{ stmt: string; error: string }> = []
  const failed: Array<{ stmt: string; error: string }> = []
  for (const stmt of statements) {
    try {
      await c.env.DB.prepare(stmt).run()
      applied.push(stmt.slice(0, 60))
    } catch (e) {
      const error = (e as Error)?.message?.slice(0, 200) ?? "failed"
      if (isToleratedSchemaError(stmt, error)) {
        tolerated.push({ stmt: stmt.slice(0, 60), error })
        applied.push(stmt.slice(0, 60))
      } else {
        failed.push({ stmt: stmt.slice(0, 60), error })
      }
    }
  }
  await writeAudit(c.env.DB, {
    actorId: auth.actorId,
    action: "apply_schema",
    detail: `applied=${applied.length} tolerated=${tolerated.length} failed=${failed.length}`,
    nowMs: Date.now(),
  })
  return c.json(
    {
      ok: failed.length === 0,
      applied: applied.length,
      total: statements.length,
      tolerated,
      failed,
    },
    failed.length === 0 ? 200 : 207,
  )
})

// GET /admin/audit —— 审计日志
api.get("/admin/audit", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  const rows = await listAudit(c.env.DB, {
    limit: Number(c.req.query("limit") ?? 50),
    offset: Number(c.req.query("offset") ?? 0),
  })
  return c.json({ rows })
})

// ─────────────────────────────────────────────────────────────────────────────
// 摄取历史记账（ingest_runs）—— 技术债 #1：摄取跑在 GitHub Actions（无 D1 绑定），
// 由 Actions 调这两个端点让 Worker 代笔，后台才看得见摄取历史（history.md §8.2 第 1 条）。
// 鉴权：adminAuthorize（ADMIN_API_KEY 或 admin JWT）。
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/ingest/runs —— 追加一条摄取记录
//   header: Authorization: Bearer <ADMIN_API_KEY>
//   body:   { wiki_id, status: "success"|"failed", commit_sha?, started_at?, finished_at?,
//             files_changed?, chunks_upserted?, error? }
// 字段映射（粗粒度摘要 → 细粒度列）见 src/ingestruns.ts 文件头。
// 返回：{ ok:true, run }（含落库后的整行，便于 Actions 日志核对）；校验失败 → 422；D1 异常 → 503。
api.post("/admin/ingest/runs", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  let body: unknown = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const parsed = parseIngestRunInput(body, Date.now())
  if (!parsed.ok) return c.json({ error: parsed.error }, 422)

  try {
    await insertIngestRun(c.env.DB, parsed.run)
  } catch {
    // 记账端点的失败必须可见（这里除了记账没有别的事），不回显 SQL/驱动细节
    return c.json({ error: "db-unavailable" }, 503)
  }
  return c.json({ ok: true, run: parsed.run })
})

// GET /admin/ingest/runs?limit=20 —— 最近若干条（按 finished_at DESC，未完成的排最后）
// 只读；limit 缺省 20、夹到 [1,200]。
api.get("/admin/ingest/runs", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const limit = clampIngestRunsLimit(c.req.query("limit"))
  try {
    const runs = await listIngestRuns(c.env.DB, limit)
    return c.json({ runs, limit })
  } catch {
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// "零 chunk 文件集合"（技术债 #5：极短文件每轮增量都被复核）
// 复用 `ingest_files` 表的新列 `blob_sha`（只有它非空的行属于本集合）：
//   · GET  取集合（path → git blob sha），Actions 侧据此跳过"sha 未变的 0-chunk 文件"；
//   · POST 批量登记/移除（一轮一次往返，不 N 次请求）。
// 鉴权：adminAuthorize；只处理 path + sha + 计数，不收也不回显任何密钥（详见 src/ingestfiles.ts 文件头）。
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/ingest/files?wiki_id=<id> —— 该 wiki 的"零 chunk 集合"
// 返回：{ ok:true, wiki_id, files:[{path, blob_sha}], count, truncated }
// 只返回 blob_sha 非空的行：Worker 侧摄取写的行（只有 content_hash）不会出现在这里。
api.get("/admin/ingest/files", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const wikiId = (c.req.query("wiki_id") ?? "").trim()
  if (!wikiId) return c.json({ error: "wiki_id-required" }, 422)

  try {
    const { files, truncated } = await listZeroChunkFiles(c.env.DB, wikiId)
    return c.json({ ok: true, wiki_id: wikiId, files, count: files.length, truncated })
  } catch {
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// POST /admin/ingest/files —— 批量登记"0 chunk 文件"、批量移除不再属于集合的 path
//   body: { wiki_id, zero_chunk?: [{path, blob_sha}], drop?: [path] }
//   · zero_chunk → upsert（ON CONFLICT DO UPDATE，只改 blob_sha/updated_at，不动 content_hash）
//   · drop       → DELETE（文件本轮产出了 chunk，或已从仓库消失）
// 单请求上限 2000 条（超出截断并在响应里标 truncated）；单条非法只跳过并计数（不 422）。
// 返回：{ ok:true, wiki_id, zero_chunk, dropped, skipped, truncated }
api.post("/admin/ingest/files", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  let body: unknown = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const parsed = parseIngestFilesInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 422)

  try {
    await applyIngestFilesPlan(c.env.DB, parsed.plan, Date.now())
  } catch {
    // 失败必须可见（Actions 侧会软失败：本轮照旧复核，不影响摄取）
    return c.json({ error: "db-unavailable" }, 503)
  }
  return c.json({
    ok: true,
    wiki_id: parsed.plan.wiki_id,
    zero_chunk: parsed.plan.zero_chunk.length,
    dropped: parsed.plan.drop.length,
    skipped: parsed.plan.skipped,
    truncated: parsed.plan.truncated,
  })
})

// POST /api/v1/admin/ingest/trigger —— 手动触发 ingest（T2.2 运维入口，受 ADMIN_API_KEY 保护）
//   query:  wiki_id=<id>  可选，只触发单个 wiki；缺省触发全部注册 wiki。
//           reset=1       可选，先清 D1 的 ingest 状态（ingest_runs 成功 commit + ingest_files hash），
//                         强制下次 ingest 全量重嵌（用于重刷 url / 重建向量）。危险，需 ADMIN_API_KEY。
//   header:  Authorization: Bearer <ADMIN_API_KEY>
// 返回：每个目标 wiki 的 Queue 投递结果（实际 ingest 在后台 queue consumer 异步执行）。
api.post("/admin/ingest/trigger", async (c) => {
  const key = c.env.ADMIN_API_KEY
  if (!key) return c.json({ error: "admin-key-unconfigured" }, 503)
  const auth = c.req.header("Authorization") ?? ""
  if (auth !== `Bearer ${key}`) return c.json({ error: "unauthorized" }, 401)

  const wikiId = c.req.query("wiki_id")
  const reset = c.req.query("reset") === "1"
  const targets = wikiId ? (isValidCorpus(wikiId) ? [wikiId] : []) : listWikis().map((w) => w.id)
  if (targets.length === 0) return c.json({ error: wikiId ? "invalid-corpus" : "no-wikis" }, 422)

  // reset=1：清 D1 的 ingest 状态，强制全量重嵌。逐个 try，避免一个失败阻断全部。
  const resetResults: Record<string, string> = {}
  if (reset && c.env.DB) {
    for (const id of targets) {
      try {
        await c.env.DB.prepare("DELETE FROM ingest_runs WHERE wiki_id = ?").bind(id).run()
        await c.env.DB.prepare("DELETE FROM ingest_files WHERE wiki_id = ?").bind(id).run()
        resetResults[id] = "ok"
      } catch (e) {
        resetResults[id] = `error:${(e as Error)?.message ?? "db-failed"}`
      }
    }
  } else if (reset && !c.env.DB) {
    return c.json({ error: "db-unavailable-for-reset" }, 503)
  }

  // 发 Queue 消息（与实际 scheduled 完全一致：后台 queue consumer 异步 ingest）。
  const sent: string[] = []
  const failed: string[] = []
  for (const id of targets) {
    try {
      await c.env.INGEST_QUEUE.send({ wikiId: id } as IngestMessage)
      sent.push(id)
    } catch {
      failed.push(id)
    }
  }
  return c.json({ reset: reset ? resetResults : undefined, sent, failed }, failed.length === 0 ? 200 : 503)
})

// POST /api/v1/admin/backfill-urls —— 存量数据 url 回填（只改 Qdrant payload，不重新 embed）
//   query:  wiki_id=<id>   必填
//           offset=<scroll offset>  可选，续跑上一页返回的 next_offset
//           page_size=<n>           可选，单页点数（默认 100，上限 500）
//   header: Authorization: Bearer <ADMIN_API_KEY>
// 免费版单次子请求上限 50，故按页处理：返回 { ..., next_offset, done }，done=false 时带 next_offset 续跑。
api.post("/admin/backfill-urls", async (c) => {
  const key = c.env.ADMIN_API_KEY
  if (!key) return c.json({ error: "admin-key-unconfigured" }, 503)
  if ((c.req.header("Authorization") ?? "") !== `Bearer ${key}`) return c.json({ error: "unauthorized" }, 401)

  const wikiId = c.req.query("wiki_id")
  if (!wikiId) return c.json({ error: "wiki_id-required" }, 422)
  if (!isValidCorpus(wikiId)) return c.json({ error: "invalid-corpus" }, 422)

  const offsetRaw = c.req.query("offset")
  const pageRaw = c.req.query("page_size")
  const pageSize = pageRaw ? parseInt(pageRaw, 10) : undefined

  try {
    const result = await backfillWikiUrls(c.env, wikiId, {
      offset: offsetRaw,
      pageSize: Number.isFinite(pageSize as number) ? pageSize : undefined,
    })
    return c.json(result)
  } catch (e) {
    const msg = (e as Error)?.message ?? "backfill-failed"
    // 不回显 key；只回泛化原因（unknown-wiki / qdrant-unconfigured / qdrant-*）。
    return c.json({ error: msg.slice(0, 200) }, 502)
  }
})

app.route("/api/v1", api)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  // ── Cron Trigger（T2.2）：UTC 01:00，对每个 wiki 发一条 Queue 消息（单 wiki 失败互不影响）──
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobs = listWikis().map((w) =>
      env.INGEST_QUEUE.send({ wikiId: w.id } as IngestMessage).catch(() => {
        console.error(`[ingest] 发送 Queue 消息失败 wiki=${w.id}`)
      }),
    )
    ctx.waitUntil(Promise.allSettled(jobs).then(() => undefined))
  },

  // ── Queue consumer（T2.2）：每消息一个 wikiId → 增量 ingest；单 wiki 失败记 ingest_runs error，不整体抛 ──
  async queue(batch: MessageBatch<IngestMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      const wikiId = msg.body?.wikiId
      if (!wikiId) {
        msg.retry()
        continue
      }
      ctx.waitUntil(
        ingestWiki(env, wikiId).catch((e) => {
          console.error(`[ingest] wiki=${wikiId} 失败: ${(e as Error)?.message ?? String(e)}`)
        }),
      )
    }
  },
}
