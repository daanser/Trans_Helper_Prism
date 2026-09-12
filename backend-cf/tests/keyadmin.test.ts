// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Key 池管理单测（tasks.md T3.3「上架/禁用 key」+ 运行时效）
// 全 mock：KV（内存，可注入失败）、fetch（embedding/rerank/Qdrant 全假）。零网络。
// 覆盖：
//   ① ref 形状校验 / KV 值解析（**真 key 形状进不来**）；
//   ② readDeniedPools / setKeyDenied 的 fail-open（KV 缺失、读失败、写失败、脏值）；
//   ③ KeyPool 的 denied 过滤（构造注入 + 运行中热更新）与池耗尽；
//   ④ 运行时效端到端：工厂入参剔除被禁 ref（embedding 用的是另一把 key）；
//   ⑤ 真路由 /api/v1/search 在「禁用 pool-key-0」后仍可用且不用被禁 key，KV 抛错时不动任何 key。
//
// 2026-09-12 合并池重构（plan-keypool.md）：密钥只认 `POOL_KEYS_<n>`，ref 形如 `pool-key-<n>[#k]`，
// 禁用集**只有一个 KV 键** `keydeny:keys`，且"禁用一把 key = 全能力禁用"。
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ADMIN_KEY_ROW_LIMIT,
  KEY_DENY_KEY,
  KEY_DENY_PREFIX,
  POOL_CAPABILITIES,
  buildPoolInfos,
  fetchProviderKeyRows,
  isPoolName,
  isSafeKeyRef,
  denyCacheTtlSec,
  kvDenyStore,
  normalizePoolName,
  parseDenyList,
  poolRefsFromEnv,
  readDeniedPools,
  readDeniedPoolsCached,
  refIndex,
  serializeDenyList,
  setKeyDenied,
  toAdminKeyRow,
  type DenyKvStore,
} from "../src/keyadmin"
import { KeyPool, type KeyPoolDb } from "../src/keypool"
import { createEmbeddingProvider } from "../src/embeddings"
import { createRerankProvider } from "../src/rerank"
import { app } from "../src/index"
import { MERGED_POOL_NAME } from "../src/keypool"
import { poolKeysEnv } from "./poolKeysEnv"
import type { Env } from "../src/types"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 明显假的占位 secret（绝不是真 key）：只用于「不得泄漏」的断言与选 key 断言。 */
const EMBED_SECRETS = ["sk-fake-embed-0001", "sk-fake-embed-0002"]
const LLM_SECRETS = ["sk-fake-llm-0001", "sk-fake-llm-0002"]

/** 合并池的 env 夹具：4 把 key → `pool-key-0` … `pool-key-3`（前两把 = 原 embed，后两把 = 原 llm）。 */
const POOL_ENV = poolKeysEnv([...EMBED_SECRETS, ...LLM_SECRETS])

const noopDb: KeyPoolDb = { async recordUsage() {} }

/** 内存 KV mock（可注入读/写失败）。 */
function makeKv(opts: { failGet?: boolean; failPut?: boolean; seed?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}))
  const kv = {
    get: async (k: string) => {
      if (opts.failGet) throw new Error("kv-get-failed")
      return store.get(k) ?? null
    },
    put: async (k: string, v: string) => {
      if (opts.failPut) throw new Error("kv-put-failed")
      store.set(k, v)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

// ─────────────────────────── ref 形状与 KV 值 ───────────────────────────

describe("ref 形状与 KV 值解析", () => {
  it("isSafeKeyRef 只认 <name>-key-<n>[#k]，真 key 形状一律拒绝", () => {
    expect(isSafeKeyRef("pool-key-0")).toBe(true)
    expect(isSafeKeyRef("pool-key-12")).toBe(true)
    expect(isSafeKeyRef("pool-key-2#3")).toBe(true) // 一个变量里逗号多把的第 k 把
    expect(isSafeKeyRef("sk-fake-embed-0001")).toBe(false) // 真 key 形状（绝不进 KV/审计）
    expect(isSafeKeyRef("llm-key")).toBe(false)
    expect(isSafeKeyRef("key-0")).toBe(false)
    expect(isSafeKeyRef("")).toBe(false)
    expect(isSafeKeyRef(undefined)).toBe(false)
    expect(isSafeKeyRef({ toString: () => "llm-key-0" })).toBe(false)
    expect(isSafeKeyRef("a".repeat(60) + "-key-0")).toBe(false) // 超长
  })

  it("refIndex / isPoolName（`keys` 与旧能力名都接受，统一映射到合并池）", () => {
    expect(refIndex("pool-key-7")).toBe(7)
    expect(refIndex("pool-key-7#2")).toBe(7) // `#k` 后缀不影响序号
    expect(refIndex("nope")).toBeNull()
    expect(isPoolName("keys")).toBe(true)
    expect(isPoolName("embed")).toBe(true)
    expect(isPoolName("rerank")).toBe(true)
    expect(isPoolName("other")).toBe(false)
    // 归一：四种写法 → 唯一池名 keys（旧能力名是"从哪个能力入口调进来"的标签，不再是对外池）
    for (const v of ["keys", "embed", "llm", "rerank"]) expect(normalizePoolName(v)).toBe(MERGED_POOL_NAME)
    expect(POOL_CAPABILITIES).toEqual(["embed", "llm", "rerank"])
  })

  it("parseDenyList：去空白/去重/丢弃非法与真 key 形状/稳定排序", () => {
    expect(parseDenyList(" pool-key-2 , pool-key-0 ,pool-key-2, sk-fake-x, , ")).toEqual(["pool-key-0", "pool-key-2"])
    expect(parseDenyList("")).toEqual([])
    expect(parseDenyList(null)).toEqual([])
    expect(parseDenyList(undefined)).toEqual([])
    expect(parseDenyList("not-a-ref")).toEqual([])
  })

  it("serializeDenyList ↔ parseDenyList 往返一致", () => {
    expect(serializeDenyList(["pool-key-1", "pool-key-0", "pool-key-1"])).toBe("pool-key-0,pool-key-1")
    expect(parseDenyList(serializeDenyList(["pool-key-3"]))).toEqual(["pool-key-3"])
    expect(parseDenyList(serializeDenyList(["pool-key-2#3"]))).toEqual(["pool-key-2#3"])
    expect(serializeDenyList([])).toBe("")
    // 真 key 形状被过滤掉，绝不落进 KV 值
    expect(serializeDenyList(["sk-fake-embed-0001"])).toBe("")
  })

  // 注：原 `mapPoolRefs()`（把 llm 池禁用按序号映射到 rerank 池）已随合并池删除 —— 一把 key 就是一个整体，
  // 不存在"跨池映射"这回事；对应守卫见下面的 readDeniedPools 单键用例。
})

// ─────────────────────────── env 池 ref（只出 ref） ───────────────────────────

describe("poolRefsFromEnv / buildPoolInfos（合并池：只有一项 keys）", () => {
  const env = POOL_ENV

  it("只返回 ref，绝不返回 secret；三个能力入口看到同一份 ref", () => {
    expect(poolRefsFromEnv(env)).toEqual(["pool-key-0", "pool-key-1", "pool-key-2", "pool-key-3"])
    // 传能力名也一样（参数保留只为调用点零改动）
    expect(poolRefsFromEnv(env, "embed")).toEqual(poolRefsFromEnv(env, "rerank"))

    const infos = buildPoolInfos(env)
    expect(infos).toEqual([{ pool: "keys", configured: 4, refs: ["pool-key-0", "pool-key-1", "pool-key-2", "pool-key-3"] }])
    const json = JSON.stringify(infos)
    expect(json).not.toMatch(/sk-/)
    for (const sec of [...EMBED_SECRETS, ...LLM_SECRETS]) expect(json).not.toContain(sec)
  })

  it("env 未配 key → 单项 configured 0 / refs []（不抛错）—— watchdog ④ 据此告警补货", () => {
    expect(buildPoolInfos({})).toEqual([{ pool: "keys", configured: 0, refs: [] }])
    expect(buildPoolInfos(undefined)[0].refs).toEqual([])
    // 只有 `POOL_KEYS_<n>` 被识别：**其它名字一律忽略**（本次不留兼容）
    expect(buildPoolInfos({ POOL_KEY_0: "sk-old", POOL_KEYS_X: "sk-old2", POOL_KEYS_0x: "sk-old3" })).toEqual([
      { pool: "keys", configured: 0, refs: [] },
    ])
  })
})

// ─────────────────────────── readDeniedPools / setKeyDenied（fail-open） ───────────────────────────

describe("readDeniedPools（合并池：单键 keydeny:keys，fail-open）", () => {
  const env = POOL_ENV

  it("KV 缺失 → 全空（不抛错）", async () => {
    expect(await readDeniedPools(undefined, env)).toEqual({ embed: [], llm: [], rerank: [] })
  })

  it("读到禁用集合：**一个键**映射进三个能力槽位（禁用 = 全能力）", async () => {
    const { kv } = makeKv({ seed: { [KEY_DENY_KEY]: "pool-key-0,pool-key-2" } })
    expect(await readDeniedPools(kvDenyStore(kv), env)).toEqual({
      embed: ["pool-key-0", "pool-key-2"],
      llm: ["pool-key-0", "pool-key-2"],
      rerank: ["pool-key-0", "pool-key-2"],
    })
  })

  it("旧的三个键（keydeny:embed|llm|rerank）**被忽略**（线上是空集；不做兼容）", async () => {
    const { kv } = makeKv({
      seed: { [`${KEY_DENY_PREFIX}llm`]: "llm-key-0", [`${KEY_DENY_PREFIX}embed`]: "embed-key-1" },
    })
    expect(await readDeniedPools(kvDenyStore(kv), env)).toEqual({ embed: [], llm: [], rerank: [] })
  })

  it("KV 读抛错 / 脏值 → 视为无禁用（fail-open，绝不抛错）", async () => {
    const { kv } = makeKv({ failGet: true })
    expect(await readDeniedPools(kvDenyStore(kv), env)).toEqual({ embed: [], llm: [], rerank: [] })

    const dirty: DenyKvStore = {
      get: async () => "{not-a-list} sk-fake-embed-0001",
      put: async () => undefined,
    }
    expect(await readDeniedPools(dirty, env)).toEqual({ embed: [], llm: [], rerank: [] })
  })
})

describe("readDeniedPoolsCached（性能优化第二轮 B：进程内缓存）", () => {
  const env = POOL_ENV

  it("TTL 内只读一次 KV（第二次命中缓存，0 次 KV 读）", async () => {
    let gets = 0
    const kv: DenyKvStore = {
      get: async (k) => {
        gets++
        return k === KEY_DENY_KEY ? "pool-key-1" : ""
      },
      put: async () => undefined,
    }
    const t0 = 1_800_000_000_000
    const first = await readDeniedPoolsCached(kv, env, t0)
    expect(first.embed).toEqual(["pool-key-1"])
    expect(gets).toBe(1) // 合并池后只读**一个**键（原先是三个池各读一次）
    const second = await readDeniedPoolsCached(kv, env, t0 + 29_000) // TTL 30s 内
    expect(second).toEqual(first)
    expect(gets).toBe(1) // 没有新增 KV 读
  })

  it("TTL 过后会重读（禁用集变化最多滞后 30 秒）", async () => {
    let value = ""
    let gets = 0
    const kv: DenyKvStore = {
      get: async () => {
        gets++
        return value
      },
      put: async () => undefined,
    }
    const t0 = 1_800_000_000_000
    expect((await readDeniedPoolsCached(kv, env, t0)).embed).toEqual([])
    expect(gets).toBe(1) // 合并池：一次读只碰 keydeny:keys 一个键

    value = "pool-key-1" // 管理端刚下架 pool-key-1
    expect((await readDeniedPoolsCached(kv, env, t0 + 10_000)).embed).toEqual([]) // 仍在 TTL 内 → 旧值
    expect(gets).toBe(1)

    const refreshed = await readDeniedPoolsCached(kv, env, t0 + 30_000) // TTL 到期
    expect(refreshed.embed).toEqual(["pool-key-1"])
    expect(gets).toBe(2)
  })

  it("env KEY_DENY_CACHE_TTL_SEC=0 → 关闭缓存（每次都读）", async () => {
    let gets = 0
    const kv: DenyKvStore = {
      get: async () => {
        gets++
        return ""
      },
      put: async () => undefined,
    }
    const noCache = { ...env, KEY_DENY_CACHE_TTL_SEC: "0" }
    await readDeniedPoolsCached(kv, noCache, 1)
    await readDeniedPoolsCached(kv, noCache, 2)
    expect(gets).toBe(2)
  })

  it("KV 读失败 → 空集且不抛错（fail-open），并且失败结果也会被缓存住", async () => {
    let gets = 0
    const kv: DenyKvStore = {
      get: async () => {
        gets++
        throw new Error("kv-down")
      },
      put: async () => undefined,
    }
    const t0 = 1_800_000_000_000
    expect(await readDeniedPoolsCached(kv, env, t0)).toEqual({ embed: [], llm: [], rerank: [] })
    expect(await readDeniedPoolsCached(kv, env, t0 + 1_000)).toEqual({ embed: [], llm: [], rerank: [] })
    expect(gets).toBe(1) // 第二次没有再去撞 KV（等价于"这段时间视为无禁用"）
  })

  it("KV 缺失（无绑定）→ 空集；TTL 非法值回默认 30s", async () => {
    expect(await readDeniedPoolsCached(undefined, env, 0)).toEqual({ embed: [], llm: [], rerank: [] })
    expect(denyCacheTtlSec({})).toBe(30)
    expect(denyCacheTtlSec({ KEY_DENY_CACHE_TTL_SEC: "abc" })).toBe(30)
    expect(denyCacheTtlSec({ KEY_DENY_CACHE_TTL_SEC: "-5" })).toBe(0)
    expect(denyCacheTtlSec({ KEY_DENY_CACHE_TTL_SEC: "120" })).toBe(120)
  })
})

describe("setKeyDenied（合并池：只写一个键 keydeny:keys）", () => {
  it("禁用加入、上架移除，KV 值只含 ref", async () => {
    const { kv, store } = makeKv()
    let out = await setKeyDenied(kvDenyStore(kv), "pool-key-0", false)
    expect(out).toEqual({ ok: true, refs: ["pool-key-0"] })
    out = await setKeyDenied(kvDenyStore(kv), "pool-key-2", false)
    expect(out.refs).toEqual(["pool-key-0", "pool-key-2"])
    out = await setKeyDenied(kvDenyStore(kv), "pool-key-0", true)
    expect(out).toEqual({ ok: true, refs: ["pool-key-2"] })

    expect(store.get(KEY_DENY_KEY)).toBe("pool-key-2")
    // 只写这一个键（旧的三键不再产生）
    expect([...store.keys()]).toEqual([KEY_DENY_KEY])
    expect(JSON.stringify([...store.entries()])).not.toMatch(/sk-/)
  })

  it("KV 缺失 / 写失败 / ref 非法 → ok:false（fail-open，不抛错、不写入）", async () => {
    expect(await setKeyDenied(undefined, "pool-key-0", false)).toEqual({ ok: false, refs: [] })

    const { kv, store } = makeKv({ failPut: true })
    expect(await setKeyDenied(kvDenyStore(kv), "pool-key-0", false)).toEqual({ ok: false, refs: [] })
    expect(store.size).toBe(0)

    const { kv: good, store: goodStore } = makeKv()
    expect(await setKeyDenied(kvDenyStore(good), "sk-fake-llm-0001", false)).toEqual({ ok: false, refs: [] })
    expect(goodStore.size).toBe(0)
  })
})

// ─────────────────────────── KeyPool denied 过滤 ───────────────────────────

describe("KeyPool 的 denied 过滤（admin 下架 = 运行时效；合并池 = **全能力**禁用）", () => {
  /** 两把 key（pool-key-0 / pool-key-1）的最小夹具 */
  const env = poolKeysEnv(["sk-fake-a", "sk-fake-b"])

  it("构造注入 denied → pickKey 跳过被禁 ref，availableCount 同步，keys() 仍可查全部", () => {
    const pool = new KeyPool(env, noopDb, { denied: { embed: ["pool-key-0"] } })
    expect(pool.isDenied("embed", "pool-key-0")).toBe(true)
    expect(pool.deniedRefs("embed")).toEqual(["pool-key-0"])
    expect(pool.availableCount("embed")).toBe(1)
    expect(pool.keys("embed")).toHaveLength(2) // 池内仍在（便于 admin 展示/再上架）
    expect(pool.pickKey("embed")!.ref).toBe("pool-key-1")
  })

  it("**禁用即全能力**：禁 pool-key-0 后 embed/rerank/llm 三个入口都只剩 pool-key-1", () => {
    const pool = new KeyPool(env, noopDb, { denied: { llm: ["pool-key-0"] } }) // 从 llm 入口禁
    for (const ability of ["embed", "llm", "rerank"] as const) {
      expect(pool.isDenied(ability, "pool-key-0"), ability).toBe(true)
      expect(pool.pickKey(ability)!.ref, ability).toBe("pool-key-1")
    }
    // 三个能力槽位看到同一份禁用集
    expect(pool.deniedRefs("embed")).toEqual(pool.deniedRefs("rerank"))
  })

  it("运行中热更新：setDenied 立刻生效；setDenied(null) 恢复", () => {
    const pool = new KeyPool(env, noopDb)
    expect(pool.pickKey("embed")!.ref).toBe("pool-key-0") // LRU：首取第一把
    pool.setDenied("embed", ["pool-key-0"])
    expect(pool.pickKey("embed")!.ref).toBe("pool-key-1")
    pool.setDenied("embed", null)
    expect(pool.deniedRefs("embed")).toEqual([])
    expect(pool.availableCount("embed")).toBe(2)
  })

  it("全部被禁 → pickKey 返回 null（不抛错，交给上层降级）", () => {
    const pool = new KeyPool(env, noopDb, { denied: { embed: ["pool-key-0", "pool-key-1"] } })
    expect(pool.availableCount("embed")).toBe(0)
    expect(pool.pickKey("embed")).toBeNull()
  })

  it("applyDenied 批量注入（三次写入的是同一个集合）；默认（不传）= 无禁用", () => {
    const pool = new KeyPool(env, noopDb)
    pool.applyDenied({ embed: ["pool-key-1"], llm: ["pool-key-1"], rerank: ["pool-key-1"] })
    expect(pool.deniedRefs("embed")).toEqual(["pool-key-1"])
    expect(pool.pickKey("llm")!.ref).toBe("pool-key-0")

    const fresh = new KeyPool(env, noopDb)
    expect(fresh.deniedRefs("embed")).toEqual([])
    expect(fresh.availableCount("embed")).toBe(2)
  })
})

// ─────────────────────────── 工厂入参 → 真的换 key（运行时效） ───────────────────────────

/** 记录 Authorization 的 fetch mock；embedding 返回 8 维向量。 */
function makeEmbedFetch() {
  const auths: string[] = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
    auths.push(auth)
    void url
    return new Response(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, auths }
}

describe("createEmbeddingProvider 的 denied 入参", () => {
  const env = poolKeysEnv([EMBED_SECRETS[0], EMBED_SECRETS[1]])

  it("被禁的 pool-key-0 不会被使用（换用 pool-key-1）", async () => {
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider({ ...env, EMBEDDING_DIM: "8" }, noopDb, fetchImpl, {
      denied: { embed: ["pool-key-0"] },
    })
    const vec = await provider.embed("激素", { kind: "query" })
    expect(vec).toHaveLength(8)
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[1]}`])
  })

  it("fail-open：KV 抛错 → 无禁用 → 仍用第一把 key（检索不受管理面故障影响）", async () => {
    const { kv } = makeKv({ failGet: true })
    const denied = await readDeniedPools(kvDenyStore(kv), env)
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider({ ...env, EMBEDDING_DIM: "8" }, noopDb, fetchImpl, { denied })
    await provider.embed("激素", { kind: "query" })
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
  })

  it("不传 options（旧调用）行为不变 → 用第一把 key", async () => {
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider({ ...env, EMBEDDING_DIM: "8" }, noopDb, fetchImpl)
    await provider.embed("激素", { kind: "query" })
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
  })
})

describe("createRerankProvider 的 denied 入参（与 embedding 同一个池）", () => {
  const env = poolKeysEnv(LLM_SECRETS)

  it("被禁的 pool-key-0 不会被 rerank 使用", async () => {
    const auths: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      auths.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""))
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { provider } = createRerankProvider(env, noopDb, fetchImpl, { denied: { rerank: ["pool-key-0"] } })
    const scores = await provider.rerank("激素", ["doc"])
    expect(scores).toEqual([0.9])
    expect(auths).toEqual([`Bearer ${LLM_SECRETS[1]}`])
  })
})

// ─────────────────────────── provider_keys 投影 ───────────────────────────

describe("toAdminKeyRow / fetchProviderKeyRows", () => {
  it("字段投影与类型兜底（enabled INTEGER → boolean，缺列不炸）", () => {
    expect(
      toAdminKeyRow({
        key_ref: "pool-key-0",
        pool: "keys",
        status: "active",
        success_count: 3,
        failure_count: 1,
        total_cost: 0.5,
        enabled: 1,
        updated_at: 123,
      }),
    ).toEqual({
      key_ref: "pool-key-0",
      pool: "keys",
      status: "active",
      success_count: 3,
      failure_count: 1,
      total_cost: 0.5,
      enabled: true,
      updated_at: 123,
      key_id: "pool-key-0",
      used: 0.5,
      last_used_at: 123,
    })
    const sparse = toAdminKeyRow({ key_ref: "pool-key-0", enabled: 0 })
    expect(sparse.enabled).toBe(false)
    expect(sparse.pool).toBe("keys") // 缺 pool 列时的默认值 = 合并池名
    expect(sparse.status).toBe("active")
    expect(sparse.total_cost).toBe(0)
  })

  it("只 SELECT 脱敏列，并带 LIMIT", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind(...args: unknown[]) {
            calls.push({ sql, args })
            return stmt
          },
          async all() {
            return { success: true, results: [], meta: {} }
          },
        }
        return stmt
      },
    } as unknown as D1Database
    const rows = await fetchProviderKeyRows(db)
    expect(rows).toEqual([])
    expect(calls[0].sql).not.toMatch(/secret|api_key|key_value/i)
    expect(calls[0].sql).toContain("FROM provider_keys")
    expect(calls[0].args).toEqual([ADMIN_KEY_ROW_LIMIT])
  })
})

// ─────────────────────────── 端到端：/api/v1/search 的运行时效 ───────────────────────────

describe("真路由 /api/v1/search 上的运行时效", () => {
  /** Qdrant + embedding 的 fetch mock；记录 embedding 用的 Authorization。 */
  function makeSearchFetch() {
    const auths: string[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
      const u = String(url)
      if (u.includes("/v1/embeddings")) {
        auths.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""))
        return new Response(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] }), { status: 200 })
      }
      if (u.includes("/points/search")) {
        return new Response(
          JSON.stringify({
            result: [
              { id: "p1", score: 0.9, payload: { title: "激素治疗", text: "正文", url: "https://u/1", path: "p1" } },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 404 })
    })
    return { fetchImpl, auths }
  }

  function makeSearchEnv(kv: KVNamespace): Env {
    return {
      DB: undefined as never,
      SEARCH_CACHE: kv,
      INGEST_QUEUE: undefined as never,
      QDRANT_URL: "https://qdrant.example",
      QDRANT_API_KEY: "qdrant-test-key",
      // 合并池：前两把是原 embed 的 key（本段断言"被禁的那把不会被用"）
      ...poolKeysEnv([EMBED_SECRETS[0], EMBED_SECRETS[1]]),
      EMBEDDING_DIM: "8",
      REQUIRE_LOGIN: "0",
    } as unknown as Env
  }

  function searchRequest() {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"], use_reranker: false, top_k: 3 }),
    }
  }

  it("KV 里禁用 pool-key-0 后：搜索照常成功，且不再使用被禁 key", async () => {
    const { kv } = makeKv({ seed: { [KEY_DENY_KEY]: "pool-key-0" } })
    const { fetchImpl, auths } = makeSearchFetch()
    vi.stubGlobal("fetch", fetchImpl)

    const resp = await app.request("/api/v1/search", searchRequest(), makeSearchEnv(kv))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { hits: unknown[]; fallback?: boolean }
    expect(body.hits).toHaveLength(1)
    expect(body.fallback).toBeFalsy()
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[1]}`])
    vi.unstubAllGlobals()
  })

  it("KV 读抛错（fail-open）→ 搜索照常成功，key 不受影响", async () => {
    const { kv } = makeKv({ failGet: true })
    const { fetchImpl, auths } = makeSearchFetch()
    vi.stubGlobal("fetch", fetchImpl)

    const resp = await app.request("/api/v1/search", searchRequest(), makeSearchEnv(kv))
    expect(resp.status).toBe(200)
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
    vi.unstubAllGlobals()
  })

  it("没有 KV 绑定（SEARCH_CACHE 缺）→ 搜索照常成功（无禁用）", async () => {
    const { fetchImpl, auths } = makeSearchFetch()
    vi.stubGlobal("fetch", fetchImpl)

    const env = makeSearchEnv(undefined as never)
    const resp = await app.request("/api/v1/search", searchRequest(), env)
    expect(resp.status).toBe(200)
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
    vi.unstubAllGlobals()
  })
})
