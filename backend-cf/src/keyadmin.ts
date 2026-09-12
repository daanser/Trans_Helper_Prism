// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Key 池管理（tasks.md T3.3「上架/禁用 key」+ T3.6 `/admin` 页）
//
// 职责边界：
//   ① `GET /admin/keys` 的数据面：provider_keys 行的**脱敏投影**（只出 `key_ref`/计数/成本，
//      绝不出现 key 明文）+ env 池的 ref 清单（`parsePoolKeys` 推导，同样只出 ref）；
//   ② `POST /admin/keys` 的写面：`provider_keys` upsert（enabled 字段）；
//   ③ **运行时效**：禁用集合放 KV（**单个** `keydeny:keys` = 逗号分隔 ref），供 KeyPool 剔除被禁 ref。
//
// ── 密钥底线（plan §9 / tasks.md 跨阶段硬性要求 2）──
// 真 key 只活在 Workers secrets（`POOL_KEYS_0` / `POOL_KEYS_1` / ……，见 keypool.ts）里，
// 本模块**从不**读取/返回/记录 secret 本身：对外一切标识都用 `key_ref`（形如 `pool-key-0`）。
// `isSafeKeyRef()` 再兜一层：只有 `<name>-key-<n>[#k]` 形状才允许进入 KV/审计，防止误把真 key 当 ref 传进来。
//
// ── fail-open（硬要求）──
// 读 KV / 解析 / 写 KV 的任何异常 → **视为无禁用**（返回空集合或 ok:false），
// 绝不抛错、绝不让搜索或 LLM 因管理面故障而失败。KV 缺失同理（返回空）。
// D1 的读写异常则向上抛给路由（管理接口如实报 503），与检索路径无关。

import { MERGED_POOL_NAME, parseMergedKeys, type PoolName } from "./keypool"

/**
 * 能力标签（embedding / 聊天 / rerank）：**不再是对外的池**，只用于"从哪个能力入口调进来"。
 * 合并池（plan-keypool.md §2.2）后对外只有一个池 `keys`。
 */
export const POOL_CAPABILITIES: readonly PoolName[] = ["embed", "llm", "rerank"] as const

/** KV 里禁用集合的 key 前缀；合并池下**只有** `keydeny:keys` 一个键（旧的三键不再读，线上为空集）。 */
export const KEY_DENY_PREFIX = "keydeny:"

/** 禁用集在 KV 里的完整键名（单池）。 */
export const KEY_DENY_KEY = `${KEY_DENY_PREFIX}${MERGED_POOL_NAME}`

/** provider_keys 单页上限（防未知规模把 admin 响应撑爆）。 */
export const ADMIN_KEY_ROW_LIMIT = 500

/** KV 最小接口（便于单测注入内存实现；KVNamespace 用 `kvDenyStore()` 适配）。 */
export interface DenyKvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

/** env 子集读取（`Env` 是 interface 无索引签名，故与 quota.ts 同款放宽为 unknown）。 */
function envString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const v = (env as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

/** 是否合法池名：`keys`（唯一真实池）或旧的能力名（兼容既有脚本，映射到同一池）。 */
export function isPoolName(v: unknown): v is PoolName | typeof MERGED_POOL_NAME {
  return v === MERGED_POOL_NAME || v === "embed" || v === "llm" || v === "rerank"
}

/** 把任意合法池名归一成唯一池名 `keys`（`embed|llm|rerank` 是历史写法，等价）。 */
export function normalizePoolName(_v: unknown): typeof MERGED_POOL_NAME {
  return MERGED_POOL_NAME
}

/**
 * key_ref 形状校验：`<name>-key-<n>` 或 `<name>-key-<n>#k`（`parseMergedKeys` 生成的就是这两种形状；
 * `#k` 是"同一变量里逗号分隔的第 k 把"）。
 * **刻意收紧**：真 key（`sk-…`）无法通过，避免把 secret 写进 KV / 审计 / 响应。
 */
export function isSafeKeyRef(ref: unknown): boolean {
  return typeof ref === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}-key-\d{1,4}(#\d{1,2})?$/.test(ref)
}

/** 从 `*-key-<n>[#k]` 取序号 n（忽略 `#k` 后缀）；不匹配 → null。 */
export function refIndex(ref: string): number | null {
  const m = /-key-(\d{1,4})(?:#\d{1,2})?$/.exec(ref)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// 注：原 `mapPoolRefs()`（把 llm 池的禁用按序号映射到 rerank 池）在**合并池**后已无意义 ——
// 一把 key 就是一个整体（禁用即全能力禁用），不再存在"跨池映射"。2026-09-12 随 plan-keypool.md §2.3 删除。

/** 去重 + 稳定排序（KV 值可比对、测试可断言）：同前缀按序号，其余按字典序。 */
function dedupeSorted(refs: readonly string[]): string[] {
  return [...new Set(refs)].sort((a, b) => {
    const ia = refIndex(a)
    const ib = refIndex(b)
    const pa = a.replace(/-key-\d{1,4}(#\d{1,2})?$/, "")
    const pb = b.replace(/-key-\d{1,4}(#\d{1,2})?$/, "")
    if (ia !== null && ib !== null && pa === pb) return ia - ib || a.localeCompare(b)
    return a.localeCompare(b)
  })
}

/** 解析 KV 里的逗号分隔禁用 ref；非法形状/空白一律丢弃（fail-open）。 */
export function parseDenyList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return []
  return dedupeSorted(raw.split(",").map((s) => s.trim()).filter((s) => isSafeKeyRef(s)))
}

/** 序列化禁用 ref 列表（KV 值形状：`llm-key-0,llm-key-2`）。 */
export function serializeDenyList(refs: readonly string[]): string {
  return parseDenyList(refs.filter((r) => isSafeKeyRef(r)).join(",")).join(",")
}

/** KVNamespace → 最小接口（缺失/异常 → undefined = 无禁用）。 */
export function kvDenyStore(kv: KVNamespace | null | undefined): DenyKvStore | undefined {
  if (!kv) return undefined
  return {
    get: (key: string) => kv.get(key),
    put: async (key: string, value: string) => {
      await kv.put(key, value)
    },
  }
}

/** 按池的禁用集合（`/admin/usage`、`/admin/keys` 响应里也用它做只读展示时可复用）。 */
export type DeniedPools = Record<PoolName, string[]>

/** 空禁用集合（fail-open 的返回值）。 */
export function emptyDeniedPools(): DeniedPools {
  return { embed: [], llm: [], rerank: [] }
}

/** 禁用集进程内缓存的默认 TTL（秒）：env `KEY_DENY_CACHE_TTL_SEC` 可覆盖。 */
export const DEFAULT_DENY_CACHE_TTL_SEC = 30

/** isolate 级缓存条目（每个 isolate 各存一份）。 */
let denyCache: { pools: DeniedPools; at: number } | null = null

/** 清空禁用集缓存（单测用；也便于运维在调试时手动失效）。 */
export function resetDeniedPoolsCache(): void {
  denyCache = null
}

/** 缓存 TTL（秒）：env `KEY_DENY_CACHE_TTL_SEC`，默认 30；`<= 0` = 关闭缓存（每次都读 KV）。 */
export function denyCacheTtlSec(env: unknown = {}): number {
  const raw = envString(env, "KEY_DENY_CACHE_TTL_SEC")
  if (raw === undefined || raw.trim() === "") return DEFAULT_DENY_CACHE_TTL_SEC
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_DENY_CACHE_TTL_SEC
  return Math.max(0, Math.floor(n))
}

/**
 * `readDeniedPools()` 的**带缓存**版本（热路径用）—— 性能优化第二轮 B。
 *
 * ── 为什么需要缓存 ──
 * 禁用集变化极少（只有管理端上下架 key 时才变），但每次搜索都会读一次 KV（3 个键、Promise.all）。
 * 线上实测：KV 未命中 get = 260–496ms，于是"永远没有 key 被禁用"的正常情况下，
 * 每个请求仍要白等 ~0.3–0.5s。缓存后 TTL 内 0 次 KV 读。
 *
 * ── 语义（改前先读）──
 *   · **fail-open 不变**：`readDeniedPools()` 自身吞错返回空集；这里连"读失败"也会被缓存 30 秒
 *     （等价于"这段时间视为无禁用"），与既有的 fail-open 取向一致。
 *   · **时效取舍（重要）**：管理端下架某个 key 后，**当前 isolate 最多 30 秒后才生效**；
 *     多 isolate（多 colo / 多实例）各自缓存，最坏情形也是 30 秒。这是刻意接受的：
 *     禁用集只是"硬控制面"（防某把 key 被滥用/欠费），**不是安全边界**，
 *     30 秒的延迟换掉每请求 0.3–0.5s 的固定成本非常划算。
 *     需要立刻生效的场景：把 `KEY_DENY_CACHE_TTL_SEC` 设成 0（关闭缓存），或等 isolate 轮换。
 *   · TTL 用注入的 `nowMs` 判定，便于单测；生产用 `Date.now()`。
 */
export async function readDeniedPoolsCached(
  kv: DenyKvStore | undefined,
  env: unknown = {},
  nowMs: number = Date.now(),
): Promise<DeniedPools> {
  const ttlSec = denyCacheTtlSec(env)
  if (ttlSec > 0 && denyCache && nowMs - denyCache.at < ttlSec * 1000) return denyCache.pools
  const pools = await readDeniedPools(kv, env)
  if (ttlSec > 0) denyCache = { pools, at: nowMs }
  return pools
}

/**
 * 读 KV 得到「被禁用的 ref」，并**映射进三个能力槽位**（合并池语义，plan-keypool.md §2.3）。
 *
 * 数据源**只有一个** KV 键 `keydeny:keys`（逗号分隔 ref）；返回的三项内容**完全相同**：
 *   · 调用点（index.ts 的 `applyDeniedToPool(pool, denied, "llm")`、`KeyPool.applyDenied`）零改动；
 *   · 语义上"禁用一把 key = embed/rerank/llm 三条链路都不可用" ✓。
 * 旧的三键（`keydeny:embed|llm|rerank`）**不再读**（线上是空集；要清可直接不管）。
 *
 * **绝不抛错**：KV 缺失 / 读失败 / 解析失败 / env 异常 → 空集合（fail-open）。
 */
export async function readDeniedPools(kv: DenyKvStore | undefined, _env: unknown = {}): Promise<DeniedPools> {
  if (!kv) return emptyDeniedPools()
  let refs: string[] = []
  try {
    refs = parseDenyList(await kv.get(KEY_DENY_KEY))
  } catch {
    refs = [] // 读失败 → 视为无禁用（fail-open）
  }
  return { embed: refs, llm: refs, rerank: refs }
}

/**
 * 上架/禁用一把 key 的**运行时效**：更新 KV 里的 `keydeny:keys`（合并池只有这一个键）。
 * `enabled=true` → 从集合移除；`enabled=false` → 加入集合。
 * **绝不抛错**（fail-open）：KV 缺失 / 写失败 / ref 非法 → `{ ok:false, refs:[] }`，
 * 调用方据此回 `runtime_applied:false`，但请求本身仍成功（DB 已记 disabled）。
 * 无 TTL：管理动作应持续生效，直到再次上架（KV 被清空则回到「全部可用」，符合 fail-open）。
 */
export async function setKeyDenied(
  kv: DenyKvStore | undefined,
  keyRef: string,
  enabled: boolean,
): Promise<{ ok: boolean; refs: string[] }> {
  if (!kv || !isSafeKeyRef(keyRef)) return { ok: false, refs: [] }
  try {
    const current = parseDenyList(await kv.get(KEY_DENY_KEY))
    const next = new Set(current.filter((r) => r !== keyRef))
    if (!enabled) next.add(keyRef)
    const refs = dedupeSorted([...next])
    await kv.put(KEY_DENY_KEY, serializeDenyList(refs))
    return { ok: true, refs }
  } catch {
    return { ok: false, refs: [] }
  }
}

/**
 * env 里配置的 key ref（**只出 ref**；secret 绝不离开本函数）。
 * 合并池后与 `pool` 无关（三个能力入口同一份），参数保留只是为了让既有调用点零改动。
 */
export function poolRefsFromEnv(env: unknown, _pool?: PoolName): string[] {
  try {
    return parseMergedKeys(env, () => undefined).map((k) => k.ref)
  } catch {
    return []
  }
}

/** 一池的对外视图（`configured` = ref 数量）。 */
export interface AdminPoolInfo {
  /** 合并池后恒为 `"keys"` */
  pool: string
  configured: number
  refs: string[]
}

/**
 * `GET /admin/keys` 的 `pools[]`：合并池后**只有一项** `{pool:"keys", configured:N, refs:[...]}`。
 * watchdog ④ 与 `/admin` 前端都是"遍历 pools[] 判 configured < 2"，因此无需改动即继续有效。
 */
export function buildPoolInfos(env: unknown): AdminPoolInfo[] {
  const refs = poolRefsFromEnv(env)
  return [{ pool: MERGED_POOL_NAME, configured: refs.length, refs }]
}

/** provider_keys 行的对外投影（脱敏）。 */
export interface AdminKeyRow {
  /** key 的引用名（如 `llm-key-0`）——**唯一的对外标识**，绝不放 secret */
  key_ref: string
  pool: string
  status: string
  success_count: number
  failure_count: number
  total_cost: number
  enabled: boolean
  updated_at: number
  // ── 以下三个是**兼容别名**（同一数据的第二投影）──
  // 前端 `pages/admin.vue` 的 keyRows 按 `key_id || id || name` 取标识、`used` 取用量、
  // `last_used_at` 取时间；缺了它们表格会显示 "—"。非敏感，故一并给出。
  key_id: string
  used: number
  last_used_at: number
}

/** DB 原始行（只 SELECT 需要列，绝不 SELECT 任何 secret 列——本表也没有）。字段可缺，投影时兜底。 */
interface ProviderKeyDbRow {
  key_ref?: unknown
  pool?: unknown
  status?: unknown
  success_count?: unknown
  failure_count?: unknown
  total_cost?: unknown
  enabled?: unknown
  updated_at?: unknown
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v !== "" ? v : fallback
}

function bool(v: unknown, fallback = true): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") return v !== "0" && v.toLowerCase() !== "false"
  return fallback
}

/** DB 行 → 对外投影。 */
export function toAdminKeyRow(row: ProviderKeyDbRow): AdminKeyRow {
  const keyRef = str(row.key_ref)
  const totalCost = num(row.total_cost)
  const updatedAt = num(row.updated_at)
  return {
    key_ref: keyRef,
    pool: str(row.pool, MERGED_POOL_NAME),
    status: str(row.status, "active"),
    success_count: num(row.success_count),
    failure_count: num(row.failure_count),
    total_cost: totalCost,
    enabled: bool(row.enabled),
    updated_at: updatedAt,
    key_id: keyRef,
    used: totalCost,
    last_used_at: updatedAt,
  }
}

/**
 * 读 provider_keys 全部行（脱敏投影）。
 * D1 异常**向上抛**（路由回 503 db-unavailable）；D1 缺失由调用方先判。
 */
export async function fetchProviderKeyRows(db: D1Database): Promise<AdminKeyRow[]> {
  const res = await db
    .prepare(
      `SELECT key_ref, pool, status, success_count, failure_count, total_cost, enabled, updated_at
         FROM provider_keys
        ORDER BY pool ASC, key_ref ASC
        LIMIT ?`,
    )
    .bind(ADMIN_KEY_ROW_LIMIT)
    .all<ProviderKeyDbRow>()
  return (res?.results ?? []).map(toAdminKeyRow)
}

/**
 * upsert 一把 key 的启用状态（T3.3「上架/禁用」）。
 * - 不存在 → 插入一行，`key_ref`/`pool` 用请求值，其余列给安全默认（status=active、计数 0、成本 0）；
 * - 已存在 → 只改 `enabled` + `updated_at`；**再次上架时**顺带清掉冷却/失败态
 *   （`status='active'`、`failure_count=0`、`cooldown_until=NULL`），让「上架」真的能救回一把 key。
 * 单条 `ON CONFLICT(pool, key_ref) DO UPDATE`（SQLite 3.24+ upsert，命中 `idx_provider_keys_pool_ref` 唯一索引），
 * 原子且幂等；绝不写入 secret（只有 `key_ref`）。
 */
export async function upsertProviderKey(
  db: D1Database,
  input: { pool: string; keyRef: string; enabled: boolean; nowMs?: number },
): Promise<void> {
  const now = input.nowMs ?? Date.now()
  const enabledFlag = input.enabled ? 1 : 0
  await db
    .prepare(
      `INSERT INTO provider_keys
         (id, pool, purpose, key_ref, status, cooldown_until, last_error,
          failure_count, success_count, total_cost, enabled, updated_at, created_at)
       VALUES (?, ?, ?, ?, 'active', NULL, NULL, 0, 0, 0, ?, ?, ?)
       ON CONFLICT(pool, key_ref) DO UPDATE SET
         enabled = excluded.enabled,
         status = CASE WHEN excluded.enabled = 1 THEN 'active' ELSE provider_keys.status END,
         failure_count = CASE WHEN excluded.enabled = 1 THEN 0 ELSE provider_keys.failure_count END,
         cooldown_until = CASE WHEN excluded.enabled = 1 THEN NULL ELSE provider_keys.cooldown_until END,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), input.pool, input.pool, input.keyRef, enabledFlag, now, now)
    .run()
}
