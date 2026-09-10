// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Key 池管理（tasks.md T3.3「上架/禁用 key」+ T3.6 `/admin` 页）
//
// 职责边界：
//   ① `GET /admin/keys` 的数据面：provider_keys 行的**脱敏投影**（只出 `key_ref`/计数/成本，
//      绝不出现 key 明文）+ env 池的 ref 清单（`parsePoolKeys` 推导，同样只出 ref）；
//   ② `POST /admin/keys` 的写面：`provider_keys` upsert（enabled 字段）；
//   ③ **运行时效**：禁用集合放 KV（`keydeny:<pool>` = 逗号分隔 ref），供 KeyPool 剔除被禁 ref。
//
// ── 密钥底线（plan §9 / tasks.md 跨阶段硬性要求 2）──
// 真 key 只活在 Workers secrets（`EMBED_POOL_KEYS` / `LLM_POOL_KEYS`，逗号分隔）里，
// 本模块**从不**读取/返回/记录 secret 本身：对外一切标识都用 `key_ref`（形如 `llm-key-0`）。
// `isSafeKeyRef()` 再兜一层：只有 `<pool>-key-<n>` 形状才允许进入 KV/审计，防止误把真 key 当 ref 传进来。
//
// ── fail-open（硬要求）──
// 读 KV / 解析 / 写 KV 的任何异常 → **视为无禁用**（返回空集合或 ok:false），
// 绝不抛错、绝不让搜索或 LLM 因管理面故障而失败。KV 缺失同理（返回空）。
// D1 的读写异常则向上抛给路由（管理接口如实报 503），与检索路径无关。

import { parsePoolKeys, type PoolName } from "./keypool"

/** 三个池的固定顺序（对外 pools[] 顺序稳定，便于前端渲染/测试断言）。 */
export const POOL_NAMES: readonly PoolName[] = ["embed", "llm", "rerank"] as const

/** KV 里禁用集合的 key 前缀：`keydeny:<pool>`。 */
export const KEY_DENY_PREFIX = "keydeny:"

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

/** 是否合法池名。 */
export function isPoolName(v: unknown): v is PoolName {
  return v === "embed" || v === "llm" || v === "rerank"
}

/**
 * key_ref 形状校验：`<pool>-key-<n>`（`parsePoolKeys` 生成的就是这个形状）。
 * **刻意收紧**：真 key（`sk-…`）无法通过，避免把 secret 写进 KV / 审计 / 响应。
 */
export function isSafeKeyRef(ref: unknown): boolean {
  return typeof ref === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}-key-\d{1,4}$/.test(ref)
}

/** 从 `*-key-<n>` 取序号；不匹配 → null。 */
export function refIndex(ref: string): number | null {
  const m = /-key-(\d{1,4})$/.exec(ref)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 把 ref 的池前缀从 from 换成 to（序号不变）：`llm-key-0` → `rerank-key-0`。
 * 只映射 `<from>-key-<n>` 形状的 ref（别的前缀原样丢弃），避免把不相关的 ref 误映射到本池。
 */
export function mapPoolRefs(from: PoolName, to: PoolName, refs: readonly string[]): string[] {
  const prefix = `${from}-key-`
  const out: string[] = []
  for (const r of refs) {
    if (!r.startsWith(prefix)) continue
    const idx = refIndex(r)
    if (idx === null) continue
    out.push(`${to}-key-${idx}`)
  }
  return dedupeSorted(out)
}

/** 去重 + 稳定排序（KV 值可比对、测试可断言）。 */
function dedupeSorted(refs: readonly string[]): string[] {
  return [...new Set(refs)].sort((a, b) => {
    const ia = refIndex(a)
    const ib = refIndex(b)
    if (ia !== null && ib !== null && a.slice(0, a.lastIndexOf("-key-")) === b.slice(0, b.lastIndexOf("-key-"))) {
      return ia - ib
    }
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

/**
 * 读 KV 得到「每个池被禁用的 ref」。
 * **绝不抛错**：KV 缺失 / 读失败 / 解析失败 / env 异常 → 空集合（fail-open）。
 * rerank 默认并入 llm_pool（plan §2）：未单独配 `RERANK_POOL_KEYS` 时，rerank 池的 ref 与 llm 池
 * 按序号一一对应，故把 llm 的禁用按序号映射到 rerank——否则「下架 llm-key-0」在默认配置下
 * 对 rerank 调用不生效（rerank 默认开，是最热的路径）。
 */
export async function readDeniedPools(kv: DenyKvStore | undefined, env: unknown = {}): Promise<DeniedPools> {
  const out = emptyDeniedPools()
  if (!kv) return out
  try {
    const read = async (pool: PoolName): Promise<string[]> => {
      try {
        return parseDenyList(await kv.get(`${KEY_DENY_PREFIX}${pool}`))
      } catch {
        return []
      }
    }
    const [embed, llm, rerank] = await Promise.all([read("embed"), read("llm"), read("rerank")])
    out.embed = embed
    out.llm = llm
    const ownRerankKeys = Boolean(envString(env, "RERANK_POOL_KEYS"))
    out.rerank = ownRerankKeys ? rerank : mapPoolRefs("llm", "rerank", llm)
    return out
  } catch {
    // 任何意外（含 Promise.all 之外的同步异常）→ 无禁用
    return emptyDeniedPools()
  }
}

/**
 * 上架/禁用一把 key 的**运行时效**：更新 KV 里的 `keydeny:<pool>`。
 * `enabled=true` → 从集合移除；`enabled=false` → 加入集合。
 * **绝不抛错**（fail-open）：KV 缺失 / 写失败 / ref 非法 → `{ ok:false, refs:[] }`，
 * 调用方据此回 `runtime_applied:false`，但请求本身仍成功（DB 已记 disabled）。
 * 无 TTL：管理动作应持续生效，直到再次上架（KV 被清空则回到「全部可用」，符合 fail-open）。
 */
export async function setKeyDenied(
  kv: DenyKvStore | undefined,
  pool: PoolName,
  keyRef: string,
  enabled: boolean,
): Promise<{ ok: boolean; refs: string[] }> {
  if (!kv || !isSafeKeyRef(keyRef)) return { ok: false, refs: [] }
  try {
    const current = parseDenyList(await kv.get(`${KEY_DENY_PREFIX}${pool}`))
    const next = new Set(current.filter((r) => r !== keyRef))
    if (!enabled) next.add(keyRef)
    const refs = dedupeSorted([...next])
    await kv.put(`${KEY_DENY_PREFIX}${pool}`, serializeDenyList(refs))
    return { ok: true, refs }
  } catch {
    return { ok: false, refs: [] }
  }
}

/** env 里某池配置的 key ref（**只出 ref**；secret 绝不离开本函数）。 */
export function poolRefsFromEnv(env: unknown, pool: PoolName): string[] {
  // rerank 默认并入 llm_pool（plan §2），与 KeyPool 构造里的取法保持一致。
  const raw =
    pool === "embed"
      ? envString(env, "EMBED_POOL_KEYS")
      : pool === "rerank"
        ? (envString(env, "RERANK_POOL_KEYS") ?? envString(env, "LLM_POOL_KEYS"))
        : envString(env, "LLM_POOL_KEYS")
  try {
    return parsePoolKeys(raw, pool).map((k) => k.ref)
  } catch {
    return []
  }
}

/** 一池的对外视图（`configured` = ref 数量）。 */
export interface AdminPoolInfo {
  pool: PoolName
  configured: number
  refs: string[]
}

/** `GET /admin/keys` 的 `pools[]`：三个池的 ref 清单（**只有 ref，没有 secret**）。 */
export function buildPoolInfos(env: unknown): AdminPoolInfo[] {
  return POOL_NAMES.map((pool) => {
    const refs = poolRefsFromEnv(env, pool)
    return { pool, configured: refs.length, refs }
  })
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
    pool: str(row.pool, "embed"),
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
  input: { pool: PoolName; keyRef: string; enabled: boolean; nowMs?: number },
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
