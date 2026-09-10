// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 配额计量与原子扣减（tasks.md T3.2）
//
// ⚠️ 模型已更正（2026-09-09，用户澄清）：**不是「每月 5 小时」，而是「滚动 5 小时窗口 + 固定 token 额度」**
// （类似 ChatGPT / Gemini 的 5 小时用量窗口）；前端**额度用量只显示百分比**，不显示 token/绝对数。
// R6 起前端额外显示**重置时刻**（`HH:MM` + "约 x 小时后"，来自下面的 window_end/reset_at/reset_in_sec）：
// 那是时间信息，不是额度数值，与"只显示百分比"的口径不冲突。
//
// ── 窗口（滚动 5h，**按注册时间网格锚定**；plan-ratelimit.md §9.2 / R6）──
// 每账号记 `window_start`(epoch ms) + `used_tokens`。
// `window_start = created_at + floor((now - created_at) / window_ms) * window_ms`
//   → 重置时刻**固定且可预测**（注册于 19:07 的账号永远在 00:07/05:07/10:07/15:07/20:07 重置）；
//   → 仍然**天然错峰**（注册时间本身分散），且长时间不活跃也**不漂移**。
// 旧实现（`window_start = now`，见 history §3 的 2026-09-09 版）会漂移、重置时刻不可预测，故已废弃。
// 窗口长度默认 5h，可用 env `QUOTA_WINDOW_HOURS` 覆盖（缺省/非法 → 5）。
//
// **无迁移脚本、零 DDL**：`ensureWindow()` 自我对齐 —— 每次请求算出「当前网格窗口起点」，
// 与库里 `period_start` 比对：一致则只读（快路径）；落后（网格推进过）→ 清零 `used_cost` 并对齐；
// 同窗口内错位（老 now 锚定数据 / 管理员重置）→ 只对齐起点、**保留用量**。
// ⚠️ 代价：ensureWindow / getQuota 各多 1 次 `accounts` 主键读（拿 `created_at` 当锚）。
// 这是有意的取舍：D1 免费额度 **读 5M 行/天**、写仅 100k 行/天（history §5 坑 14），
// 多一次读远便宜于多一次写；且**不为此新增列或 DDL**（零 schema 变更）。
//
// ── 额度（加权 token）──
// `limit_tokens` 来自 env `QUOTA_WINDOW_TOKENS`（默认 300000）；**忽略 DB 里的 monthly_limit 列**。
// 计费单位 = **加权 token**（plan §3.4/§6.2 的权重表按新单位重定）：
//   · 纯搜索（embed + 向量检索）.... QUOTA_COST.search = 200（象征性，防刷）
//   · + rerank ................... 额外 +100（合计 300）
//   · LLM 总结/追问 ............... 真实 `tokens_in + tokens_out`（由调用方传入）
//   · 关键词/结巴回退 ............. 0（不扣）
//
// ── 零 DDL（复用现有列）──
// `quotas.period_start` 改存 `window_start`，`quotas.used_cost` 改存 `used_tokens`；
// `monthly_limit` 列保留但**不再参与判定**（仅在补行时写入 legacy 默认值 5.0）。
// 旧数据（自然月 period_start / now 锚定的旧窗口 / 小时制 used_cost）可平滑迁移：
// 第一次请求时 `ensureWindow()` 就会把 `period_start` 对齐到网格起点；
// 若旧起点落后于当前网格 → 顺带清零 `used_cost`（放大到"多给一点额度"，无副作用）。
//
// ── 原子性（关键）──
// Cloudflare KV **没有原子自增**，所以扣减一律走 D1 的单条条件 UPDATE：
//   UPDATE quotas SET used_cost = used_cost + ?, updated_at = ?
//    WHERE account_id = ? AND used_cost + ? <= ?          -- 最后一个 ? = limit_tokens（env）
// （token 值绑定两次：一次累加、一次判额；单条语句 = 原子「判-扣」。）
// `meta.changes === 1` = 扣减成功；`=== 0` = 超额（或被并发抢先扣光）→ 返回
// `{ ok:false, reason:"quota-exceeded" }`，**绝不抛错**。并发下不会出现 used_tokens > limit_tokens。
//
// ── 降级 ──
// D1 缺失或 SQL 异常一律优雅降级、不抛错：chargeQuota → `{ ok:false, reason:"db-unavailable" }`，
// 写操作返回 null，getQuota 返回「放行」视图（degraded=true，used 0 / 100%），由调用方决定打 warning。

/** 加权 token 成本表（新单位；plan §3.4 方案 A 的权重按 token 重定）。 */
export const QUOTA_COST = {
  /** 纯搜索（embed + 向量检索）1 次 */
  search: 200,
  /** 开 rerank 的额外消耗 */
  rerank: 100,
  /** 关键词/结巴回退：不扣 */
  fallback: 0,
} as const

/** 默认窗口长度（小时）：5h。env `QUOTA_WINDOW_HOURS` 可覆盖。 */
export const DEFAULT_WINDOW_HOURS = 5
/** 默认窗口额度（加权 token）：300k。env `QUOTA_WINDOW_TOKENS` 可覆盖。 */
export const DEFAULT_LIMIT_TOKENS = 300_000
/** 低额提示阈值（%）：剩余 < 10% 时前端提示（plan §6.2）。 */
export const LOW_QUOTA_PCT = 10

const MS_PER_HOUR = 3_600_000

/**
 * 配额相关 env 子集（文档用；建议 captain 在 `types.ts` 的 `Env` 补上这两个可选字段以获得 IDE 提示）。
 * 注意：本模块所有 `env` 形参类型故意放宽为 `unknown`——`Env` 是 interface、无索引签名，
 * 未声明这两个字段前**无法**满足本接口（TS2559/TS2345），传 `c.env` 会编译失败；
 * 放宽后 `chargeQuota(db, id, cost, nowMs, c.env)` 可直接接线。
 */
export interface QuotaEnv {
  /** 窗口额度（加权 token），缺省 300000 */
  QUOTA_WINDOW_TOKENS?: string
  /** 窗口长度（小时），缺省 5 */
  QUOTA_WINDOW_HOURS?: string
}

/** 配额视图（前端只展示百分比 + 重置时刻；R6 新增 3 个**追加**字段，不改既有字段名）。 */
export interface QuotaView {
  /** 当前窗口起点（epoch ms；网格锚定 → 固定可预测） */
  window_start: number
  /** 窗口结束 = `window_start + window_hours*3600e3`（epoch ms） */
  window_end: number
  /** 窗口长度（小时） */
  window_hours: number
  /** 窗口额度（加权 token） */
  limit_tokens: number
  /** 本窗口已用（加权 token） */
  used_tokens: number
  /** 已用百分比，clamp(round(used/limit*100, 1), 0, 100) */
  used_pct: number
  /** 剩余百分比 = clamp(round(100 - used_pct, 1), 0, 100)（与 used_pct 相加恒为 100） */
  remaining_pct: number
  /** 是否已用尽（used_tokens >= limit_tokens） */
  exceeded: boolean
  /**
   * 下次重置时刻（epoch ms）。与 `window_end` **同一时间点**，
   * 单独给前端一个语义清晰的名字（避免前端靠 `window_start + window_hours` 手算）。
   */
  reset_at: number
  /** 距下次重置的秒数 = `max(0, ceil((window_end - now) / 1000))`，恒 >= 0 */
  reset_in_sec: number
  /** D1 缺失/异常、或 accounts 行缺失（无法取注册时间 → 只能以 now 为锚）→ true */
  degraded: boolean
}

/** 扣减结果。 */
export interface ChargeResult {
  ok: boolean
  /** 扣减后本窗口已用（加权 token）；db-unavailable 时为 0 */
  used_tokens: number
  used_pct: number
  remaining_pct: number
  /** 失败原因：quota-exceeded（超额，切回退）/ db-unavailable（放行 + warning） */
  reason?: "quota-exceeded" | "db-unavailable"
}

/** D1 绑定（允许 undefined/null 以便优雅降级）。 */
export type QuotaDb = D1Database | null | undefined

/** 保留 1 位小数。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** 夹到 [0, 100]。 */
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/** 百分比格式化：`formatPct(23.4) === "23.4%"`（非法值 → "0.0%"，并夹到 [0,100]）。 */
export function formatPct(n: number): string {
  return `${clampPct(round1(n)).toFixed(1)}%`
}

/** 解析正整数 env；缺省/非法/<=0 → fallback。 */
function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  return fallback
}

/**
 * 从任意 env 对象安全读字符串字段。
 * 参数类型故意放宽为 `unknown`：接线时可直接传 `c.env`——即使 `types.ts` 尚未声明
 * `QUOTA_WINDOW_TOKENS`/`QUOTA_WINDOW_HOURS`（Env 是 interface，无索引签名，无法满足 `QuotaEnv`）也能编译。
 */
function envString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const v = (env as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

/** 窗口长度（小时）：env `QUOTA_WINDOW_HOURS`，缺省 5。 */
export function windowHours(env: unknown = {}): number {
  return parsePositiveNumber(envString(env, "QUOTA_WINDOW_HOURS"), DEFAULT_WINDOW_HOURS)
}

/** 窗口长度（毫秒）。 */
export function windowMs(env: unknown = {}): number {
  return windowHours(env) * MS_PER_HOUR
}

/**
 * **注册时间网格锚定**（R6 核心，plan-ratelimit.md §9.2）：
 * `createdAt + floor((now - createdAt) / windowMs) * windowMs`。
 *
 * 语义与边界：
 * - 恰落在边界（`now === createdAt + k*windowMs`）→ 返回**该边界**，即"新窗口"起点；
 * - `windowMs <= 0` / 任一入参非有限值 / `createdAt > now`（时钟回拨、脏数据）→ **回退 `nowMs`**：
 *   宁可当成"从现在起开一个新窗口"，也**绝不**算出负数或未来的窗口起点（保守）；
 * - `windowMs` 非整数时按浮点算出结果后再 `Math.floor`，保证返回整数毫秒。
 */
export function gridWindowStart(createdAtMs: number, nowMs: number, windowMs: number): number {
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return nowMs
  }
  if (createdAtMs > nowMs) return nowMs
  const elapsed = nowMs - createdAtMs
  return Math.floor(createdAtMs + Math.floor(elapsed / windowMs) * windowMs)
}

/** 窗口额度（加权 token）：env `QUOTA_WINDOW_TOKENS`，缺省 300000。 */
export function limitTokens(env: unknown = {}): number {
  return Math.floor(parsePositiveNumber(envString(env, "QUOTA_WINDOW_TOKENS"), DEFAULT_LIMIT_TOKENS))
}

/** 由 used/limit 计算已用百分比（clamp 到 [0,100]，保留 1 位小数）。 */
export function usedPct(usedTokens: number, limit: number): number {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(limit) || limit <= 0) return 0
  return clampPct(round1((usedTokens / limit) * 100))
}

/** 一次请求的配额消耗输入（加权 token）。 */
export interface QuotaCostInput {
  /** 是否走了向量检索（默认 true） */
  search?: boolean
  /** 是否开了 rerank（额外 +100） */
  rerank?: boolean
  /** LLM 真实 token 数（tokens_in + tokens_out，由调用方传入） */
  llmTokens?: number
  /** 是否走了关键词/结巴回退（优先级最高：回退恒为 0） */
  fallback?: boolean
}

/** 单次请求的加权 token 消耗。回退恒 0；否则 search(200) + rerank(100) + LLM 真实 token。 */
export function computeQuotaCost(input: QuotaCostInput = {}): number {
  if (input.fallback) return QUOTA_COST.fallback
  let cost = 0
  if (input.search !== false) cost += QUOTA_COST.search
  if (input.rerank) cost += QUOTA_COST.rerank
  const llm = input.llmTokens ?? 0
  if (Number.isFinite(llm) && llm > 0) cost += Math.floor(llm)
  return cost
}

/** 剩余百分比是否低于阈值（默认 10%，plan §6.2 前端提示）。 */
export function isLowQuota(view: QuotaView, thresholdPct: number = LOW_QUOTA_PCT): boolean {
  return view.remaining_pct < thresholdPct
}

/** `SearchResponse.quota` 字段（前端只展示百分比）。 */
export interface QuotaResponseFields {
  used_pct: number
  remaining_pct: number
  fallback: boolean
}

/**
 * 视图 → `SearchResponse.quota` 投影（接线时直接用，避免字段拼错）。
 * 注：types.ts 的 `SearchResponse.quota` 需从 `{used_h, remaining_h}` 改为 `{used_pct, remaining_pct, fallback}`。
 */
export function toQuotaResponse(view: QuotaView, fallback = false): QuotaResponseFields {
  return { used_pct: view.used_pct, remaining_pct: view.remaining_pct, fallback }
}

/** 数据库行（quotas 表；`period_start`=window_start，`used_cost`=used_tokens）。 */
interface QuotaRow {
  period_start: number
  used_cost: number
  monthly_limit: number
}

/** 行 → 视图（缺列/异常值一律兜底，绝不抛错）。 */
function toView(row: QuotaRow | null, nowMs: number, env: unknown, degraded = false): QuotaView {
  const hours = windowHours(env)
  const limit = limitTokens(env)
  const span = hours * MS_PER_HOUR
  const windowStart = typeof row?.period_start === "number" && Number.isFinite(row.period_start) ? row.period_start : nowMs
  const used = typeof row?.used_cost === "number" && Number.isFinite(row.used_cost) ? Math.max(0, row.used_cost) : 0
  const pct = usedPct(used, limit)
  const windowEnd = windowStart + span
  return {
    window_start: windowStart,
    window_end: windowEnd,
    window_hours: hours,
    limit_tokens: limit,
    used_tokens: used,
    used_pct: pct,
    remaining_pct: clampPct(round1(100 - pct)),
    exceeded: used >= limit,
    reset_at: windowEnd,
    reset_in_sec: Math.max(0, Math.ceil((windowEnd - nowMs) / 1000)),
    degraded,
  }
}

/** D1 缺失/异常时的「放行」视图：新窗口、已用 0、100% 剩余、degraded=true。 */
function permissiveView(nowMs: number, env: unknown): QuotaView {
  return toView({ period_start: nowMs, used_cost: 0, monthly_limit: 0 }, nowMs, env, true)
}

/**
 * 读账号注册时间（网格锚）。
 * 返回 `null` = `accounts` 行缺失 / `created_at` 非法（理论不该发生）→ 调用方以 `nowMs` 为锚。
 * 异常 → 向上抛（由调用方 try/catch 降级，绝不静默吞成"以 now 为锚"）。
 */
async function readCreatedAt(db: D1Database, accountId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT created_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ created_at: number }>()
  const v = row?.created_at
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * 该账号「当前网格窗口起点」：`anchor === null`（accounts 行缺失）→ 回退 `nowMs` 为锚。
 * 注意：即使锚回退，也**不抛错**——视图里 `window_start` 即为 now，`degraded=true` 可见。
 */
function gridStartFor(anchorMs: number | null, nowMs: number, env: unknown): number {
  if (anchorMs === null) return nowMs
  return gridWindowStart(anchorMs, nowMs, windowMs(env))
}

/** 读 quotas 行；异常 → 抛出（由调用方捕获降级）。 */
async function readRow(db: D1Database, accountId: string): Promise<QuotaRow | null> {
  const row = await db
    .prepare("SELECT period_start, used_cost, monthly_limit FROM quotas WHERE account_id = ?")
    .bind(accountId)
    .first<QuotaRow>()
  return row ?? null
}

/**
 * 网格窗口对齐 + 保证行存在（幂等、并发安全）。R6 核心。
 *
 * 1. 读 `quotas` 行 + 读 `accounts.created_at`（锚），算出**当前网格窗口起点** `gridStart`；
 * 2. **快路径**：`period_start === gridStart` → 直接返回，**不写库**（成本 = 2 次读）；
 * 3. **慢路径**（首次触达 / 跨窗口 / 同窗口错位）：
 *    - `INSERT OR IGNORE`：补行，`period_start = gridStart`（**不是 now**）；
 *    - ① 网格推进：`UPDATE ... SET used_cost = 0, period_start = ? WHERE period_start < ?`
 *      —— 单条**条件写**，"判-改"在同一语句内原子完成；
 *    - ② 同窗口错位（老 now 锚定数据 / 旧 admin 重置）：`UPDATE ... SET period_start = ?
 *      WHERE period_start > ? AND period_start < ?`（上界 = `gridStart + window_ms`）
 *      —— 只对齐起点、**保留 used_cost**，且不会把"已被并发推进到下一窗口"的行拽回来。
 * 4. 复读行并返回视图；`accounts` 行缺失 → 以 `now` 为锚（`gridStart = nowMs`）且 `degraded=true`。
 *
 * ── 并发安全（关键）──
 * 两条 UPDATE 都是**条件写**，条件基于**读-写之间未被信任的旧值**：
 * 假设两个请求同时跨过窗口边界，都看到旧 `period_start`（落后）：
 *   - A 先执行 ①：`period_start < gridStart` 成立 → 清零并推进到新网格起点；
 *   - B 再执行 ①：此时库里 `period_start === gridStart`，条件**不再成立** → `meta.changes === 0`，**不重复清零**；
 * 所以 A 之后扣的 `used_cost` 不会被 B 抹掉（不存在"两个并发各自清零 → 用量丢失"）。
 * 反向交叉（B 的时间片还停在上一窗口）时，B 的 ① 条件同样不成立，② 又被上界排除 → 不会把窗口拽回去。
 * 与 `chargeQuota` 一样：**不读-改-写、不做多语句事务**，只靠单条条件 UPDATE 的原子性。
 * 成本：快路径 0 写（2 读）；慢路径最多 3 条写（1 INSERT + 2 条件 UPDATE），只在**窗口切换 /
 * 首次触达 / 旧数据首对齐**时发生 —— 即每账号每窗口最多一次，与 D1 的 100k 写/天相比可忽略。
 * D1 缺失/异常 → null（调用方按放行处理）。
 */
export async function ensureWindow(
  db: QuotaDb,
  accountId: string,
  nowMs: number = Date.now(),
  env: unknown = {},
): Promise<QuotaView | null> {
  if (!db || !accountId) return null
  const span = windowMs(env)
  try {
    const existing = await readRow(db, accountId)
    const anchorMs = await readCreatedAt(db, accountId)
    const gridStart = gridStartFor(anchorMs, nowMs, env)
    // 行已对齐当前网格窗口 → 快路径（只读，不写库）；accounts 缺失时 degraded 可见。
    if (existing && existing.period_start === gridStart) return toView(existing, nowMs, env, anchorMs === null)

    await db
      .prepare(
        "INSERT OR IGNORE INTO quotas (account_id, period_start, used_cost, monthly_limit, updated_at) VALUES (?, ?, 0, ?, ?)",
      )
      .bind(accountId, gridStart, 5.0, nowMs)
      .run()
    // ① 网格推进（旧起点落后于当前网格起点）→ 清零并对齐。单条条件写，并发下只会成功一次。
    await db
      .prepare("UPDATE quotas SET used_cost = 0, period_start = ?, updated_at = ? WHERE account_id = ? AND period_start < ?")
      .bind(gridStart, nowMs, accountId, gridStart)
      .run()
    // ② 同窗口内错位 → 只对齐起点、不清零；上界排除"已被推进到后面网格"的行（防把窗口拽回）。
    await db
      .prepare(
        "UPDATE quotas SET period_start = ?, updated_at = ? WHERE account_id = ? AND period_start > ? AND period_start < ?",
      )
      .bind(gridStart, nowMs, accountId, gridStart, gridStart + span)
      .run()
    const row = await readRow(db, accountId)
    return toView(row, nowMs, env, row === null || anchorMs === null)
  } catch {
    return null
  }
}

/**
 * 读配额（前端只展示百分比 + 重置时刻）。
 * **只读**：不改库。窗口/网格已推进时，视图按「新窗口」返回（`used=0`、`window_start=gridStart`）；
 * 同窗口内错位时按网格起点返回但**保留**已用量（与 `ensureWindow` 的落库语义一致）。
 * 实际落库推进由 `ensureWindow` / `chargeQuota` 完成。
 * D1 缺失/异常 → 放行视图（degraded=true）。
 */
export async function getQuota(
  db: QuotaDb,
  accountId: string,
  nowMs: number = Date.now(),
  env: unknown = {},
): Promise<QuotaView> {
  if (!db || !accountId) return permissiveView(nowMs, env)
  try {
    const row = await readRow(db, accountId)
    const anchorMs = await readCreatedAt(db, accountId)
    const gridStart = gridStartFor(anchorMs, nowMs, env)
    if (!row) return toView({ period_start: gridStart, used_cost: 0, monthly_limit: 0 }, nowMs, env, true)
    if (row.period_start !== gridStart) {
      // 网格推进过 → 视作新窗口（用量归零）；同窗口内错位 → 保留用量、起点按网格。
      const rolled = row.period_start < gridStart
      return toView(
        { ...row, period_start: gridStart, used_cost: rolled ? 0 : row.used_cost },
        nowMs,
        env,
        anchorMs === null,
      )
    }
    return toView(row, nowMs, env, anchorMs === null)
  } catch {
    return permissiveView(nowMs, env)
  }
}

/**
 * 原子扣减配额（T3.2 核心）。
 * @param tokens 加权 token 消耗（见 computeQuotaCost）
 * @param nowMs  当前时间（epoch ms；用于窗口推进）
 * @param env    读取 `QUOTA_WINDOW_TOKENS` / `QUOTA_WINDOW_HOURS`
 * 返回 `{ ok, used_tokens, used_pct, remaining_pct, reason? }`：
 *   - 成功：ok=true；
 *   - 超额：ok=false, reason="quota-exceeded"（未扣，调用方切回退分支）；
 *   - 无 D1/DB 异常：ok=false, reason="db-unavailable"（调用方按「放行 + warning」处理）。
 * tokens <= 0（如回退）直接放行，不写库。
 */
export async function chargeQuota(
  db: QuotaDb,
  accountId: string,
  tokens: number,
  nowMs: number = Date.now(),
  env: unknown = {},
): Promise<ChargeResult> {
  const cost = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
  if (!db || !accountId) {
    return { ok: false, used_tokens: 0, used_pct: 0, remaining_pct: 100, reason: "db-unavailable" }
  }
  if (cost === 0) {
    // 回退 / 零消耗：不写库，但仍回报当前窗口状态
    const view = await getQuota(db, accountId, nowMs, env)
    return { ok: true, used_tokens: view.used_tokens, used_pct: view.used_pct, remaining_pct: view.remaining_pct }
  }

  const window = await ensureWindow(db, accountId, nowMs, env)
  if (!window) {
    return { ok: false, used_tokens: 0, used_pct: 0, remaining_pct: 100, reason: "db-unavailable" }
  }

  const limit = limitTokens(env)
  try {
    // 单条原子「判-扣」：并发下不会超卖（meta.changes === 0 即超额/已被扣光）。
    const res = await db
      .prepare("UPDATE quotas SET used_cost = used_cost + ?, updated_at = ? WHERE account_id = ? AND used_cost + ? <= ?")
      .bind(cost, nowMs, accountId, cost, limit)
      .run()
    if (res?.meta?.changes === 1) {
      const view = await getQuota(db, accountId, nowMs, env)
      return { ok: true, used_tokens: view.used_tokens, used_pct: view.used_pct, remaining_pct: view.remaining_pct }
    }
    // changes === 0：超额（或行被并发删）。读一次当前状态给调用方，绝不抛错。
    const view = await getQuota(db, accountId, nowMs, env)
    return {
      ok: false,
      used_tokens: view.used_tokens,
      used_pct: view.used_pct,
      remaining_pct: view.remaining_pct,
      reason: "quota-exceeded",
    }
  } catch {
    return { ok: false, used_tokens: 0, used_pct: 0, remaining_pct: 100, reason: "db-unavailable" }
  }
}

/**
 * 管理员加/扣当前窗口的 tokens（T3.3 admin 用）。
 * - `deltaTokens > 0` = **加额**：`used_tokens = max(0, used - delta)`（释放额度）；
 * - `deltaTokens < 0` = **扣额**：`used_tokens = min(limit, used + |delta|)`；
 * 单条 `MIN(limit, MAX(0, used - delta))` 语句完成，两端都夹住。
 * 返回调整后的视图；D1 缺失/异常 → null。
 */
export async function grantQuota(
  db: QuotaDb,
  accountId: string,
  deltaTokens: number,
  nowMs: number = Date.now(),
  env: unknown = {},
): Promise<QuotaView | null> {
  if (!db || !accountId) return null
  if (!Number.isFinite(deltaTokens) || deltaTokens === 0) return getQuota(db, accountId, nowMs, env)
  const window = await ensureWindow(db, accountId, nowMs, env)
  if (!window) return null
  try {
    await db
      .prepare("UPDATE quotas SET used_cost = MIN(?, MAX(0.0, used_cost - ?)), updated_at = ? WHERE account_id = ?")
      .bind(limitTokens(env), Math.floor(deltaTokens), nowMs, accountId)
      .run()
    return await getQuota(db, accountId, nowMs, env)
  } catch {
    return null
  }
}

/**
 * 管理员重置当前窗口（误杀恢复 / 运营活动）：`used_tokens = 0`。
 * **窗口起点固定为当前网格起点**（不是 `now`）——重置不该改变该账号的重置时刻（R6）。
 * 返回重置后的视图；D1 缺失/异常 → null。
 */
export async function resetQuota(
  db: QuotaDb,
  accountId: string,
  nowMs: number = Date.now(),
  env: unknown = {},
): Promise<QuotaView | null> {
  if (!db || !accountId) return null
  const ready = await ensureWindow(db, accountId, nowMs, env)
  if (!ready) return null
  try {
    const anchorMs = await readCreatedAt(db, accountId)
    const gridStart = gridStartFor(anchorMs, nowMs, env)
    await db
      .prepare("UPDATE quotas SET used_cost = 0, period_start = ?, updated_at = ? WHERE account_id = ?")
      .bind(gridStart, nowMs, accountId)
      .run()
    return await getQuota(db, accountId, nowMs, env)
  } catch {
    return null
  }
}
