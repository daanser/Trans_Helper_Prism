// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Key 池管理单测（tasks.md T3.3「上架/禁用 key」+ 运行时效）
// 全 mock：KV（内存，可注入失败）、fetch（embedding/rerank/Qdrant 全假）。零网络。
// 覆盖：
//   ① ref 形状校验 / KV 值解析（**真 key 形状进不来**）；
//   ② readDeniedPools / setKeyDenied 的 fail-open（KV 缺失、读失败、写失败、脏值）；
//   ③ KeyPool 的 denied 过滤（构造注入 + 运行中热更新）与池耗尽；
//   ④ 运行时效端到端：工厂入参剔除被禁 ref（embedding 用的是另一把 key）；
//   ⑤ 真路由 /api/v1/search 在「禁用 embed-key-0」后仍可用且不用被禁 key，KV 抛错时不动任何 key。
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ADMIN_KEY_ROW_LIMIT,
  KEY_DENY_PREFIX,
  buildPoolInfos,
  fetchProviderKeyRows,
  isPoolName,
  isSafeKeyRef,
  kvDenyStore,
  mapPoolRefs,
  parseDenyList,
  poolRefsFromEnv,
  readDeniedPools,
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
import type { Env } from "../src/types"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 明显假的占位 secret（绝不是真 key）：只用于「不得泄漏」的断言与选 key 断言。 */
const EMBED_SECRETS = ["sk-fake-embed-0001", "sk-fake-embed-0002"]
const LLM_SECRETS = ["sk-fake-llm-0001", "sk-fake-llm-0002"]

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
  it("isSafeKeyRef 只认 <pool>-key-<n>，真 key 形状一律拒绝", () => {
    expect(isSafeKeyRef("llm-key-0")).toBe(true)
    expect(isSafeKeyRef("embed-key-12")).toBe(true)
    expect(isSafeKeyRef("sk-fake-embed-0001")).toBe(false) // 真 key 形状（绝不进 KV/审计）
    expect(isSafeKeyRef("llm-key")).toBe(false)
    expect(isSafeKeyRef("key-0")).toBe(false)
    expect(isSafeKeyRef("")).toBe(false)
    expect(isSafeKeyRef(undefined)).toBe(false)
    expect(isSafeKeyRef({ toString: () => "llm-key-0" })).toBe(false)
    expect(isSafeKeyRef("a".repeat(60) + "-key-0")).toBe(false) // 超长
  })

  it("refIndex / isPoolName", () => {
    expect(refIndex("llm-key-7")).toBe(7)
    expect(refIndex("nope")).toBeNull()
    expect(isPoolName("embed")).toBe(true)
    expect(isPoolName("rerank")).toBe(true)
    expect(isPoolName("other")).toBe(false)
  })

  it("parseDenyList：去空白/去重/丢弃非法与真 key 形状/稳定排序", () => {
    expect(parseDenyList(" llm-key-2 , llm-key-0 ,llm-key-2, sk-fake-x, , ")).toEqual(["llm-key-0", "llm-key-2"])
    expect(parseDenyList("")).toEqual([])
    expect(parseDenyList(null)).toEqual([])
    expect(parseDenyList(undefined)).toEqual([])
    expect(parseDenyList("not-a-ref")).toEqual([])
  })

  it("serializeDenyList ↔ parseDenyList 往返一致", () => {
    expect(serializeDenyList(["llm-key-1", "llm-key-0", "llm-key-1"])).toBe("llm-key-0,llm-key-1")
    expect(parseDenyList(serializeDenyList(["embed-key-3"]))).toEqual(["embed-key-3"])
    expect(serializeDenyList([])).toBe("")
    // 真 key 形状被过滤掉，绝不落进 KV 值
    expect(serializeDenyList(["sk-fake-embed-0001"])).toBe("")
  })

  it("mapPoolRefs 按序号换池前缀，且只映射源池的 ref", () => {
    expect(mapPoolRefs("llm", "rerank", ["llm-key-0", "llm-key-2"])).toEqual(["rerank-key-0", "rerank-key-2"])
    expect(mapPoolRefs("llm", "rerank", ["embed-key-0", "garbage"])).toEqual([])
  })
})

// ─────────────────────────── env 池 ref（只出 ref） ───────────────────────────

describe("poolRefsFromEnv / buildPoolInfos", () => {
  const env = {
    EMBED_POOL_KEYS: EMBED_SECRETS.join(","),
    LLM_POOL_KEYS: LLM_SECRETS.join(","),
  }

  it("只返回 ref，绝不返回 secret；rerank 未单独配则并入 llm", () => {
    expect(poolRefsFromEnv(env, "embed")).toEqual(["embed-key-0", "embed-key-1"])
    expect(poolRefsFromEnv(env, "llm")).toEqual(["llm-key-0", "llm-key-1"])
    expect(poolRefsFromEnv(env, "rerank")).toEqual(["rerank-key-0", "rerank-key-1"])

    const infos = buildPoolInfos(env)
    expect(infos).toEqual([
      { pool: "embed", configured: 2, refs: ["embed-key-0", "embed-key-1"] },
      { pool: "llm", configured: 2, refs: ["llm-key-0", "llm-key-1"] },
      { pool: "rerank", configured: 2, refs: ["rerank-key-0", "rerank-key-1"] },
    ])
    const json = JSON.stringify(infos)
    expect(json).not.toMatch(/sk-/)
    for (const s of [...EMBED_SECRETS, ...LLM_SECRETS]) expect(json).not.toContain(s)
  })

  it("env 缺池 → configured 0 / refs []（不抛错）", () => {
    expect(buildPoolInfos({})).toEqual([
      { pool: "embed", configured: 0, refs: [] },
      { pool: "llm", configured: 0, refs: [] },
      { pool: "rerank", configured: 0, refs: [] },
    ])
    expect(buildPoolInfos(undefined)[0].refs).toEqual([])
  })

  it("RERANK_POOL_KEYS 单独配置 → rerank 用自己的池", () => {
    expect(poolRefsFromEnv({ ...env, RERANK_POOL_KEYS: "sk-fake-rerank-0" }, "rerank")).toEqual(["rerank-key-0"])
  })
})

// ─────────────────────────── readDeniedPools / setKeyDenied（fail-open） ───────────────────────────

describe("readDeniedPools（fail-open）", () => {
  const env = { LLM_POOL_KEYS: LLM_SECRETS.join(",") }

  it("KV 缺失 → 全空（不抛错）", async () => {
    expect(await readDeniedPools(undefined, env)).toEqual({ embed: [], llm: [], rerank: [] })
  })

  it("读到禁用集合，并把 llm 的禁用按序号映射到 rerank（默认并入 llm 池）", async () => {
    const { kv } = makeKv({
      seed: { [`${KEY_DENY_PREFIX}llm`]: "llm-key-0", [`${KEY_DENY_PREFIX}embed`]: "embed-key-1" },
    })
    expect(await readDeniedPools(kvDenyStore(kv), env)).toEqual({
      embed: ["embed-key-1"],
      llm: ["llm-key-0"],
      rerank: ["rerank-key-0"],
    })
  })

  it("单独配了 RERANK_POOL_KEYS → rerank 只认自己的 keydeny:rerank", async () => {
    const { kv } = makeKv({
      seed: { [`${KEY_DENY_PREFIX}llm`]: "llm-key-0", [`${KEY_DENY_PREFIX}rerank`]: "rerank-key-1" },
    })
    const out = await readDeniedPools(kvDenyStore(kv), { ...env, RERANK_POOL_KEYS: "sk-fake-llm-0001" })
    expect(out.llm).toEqual(["llm-key-0"])
    expect(out.rerank).toEqual(["rerank-key-1"])
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

describe("setKeyDenied", () => {
  it("禁用加入、上架移除，KV 值只含 ref", async () => {
    const { kv, store } = makeKv()
    let out = await setKeyDenied(kvDenyStore(kv), "llm", "llm-key-0", false)
    expect(out).toEqual({ ok: true, refs: ["llm-key-0"] })
    out = await setKeyDenied(kvDenyStore(kv), "llm", "llm-key-2", false)
    expect(out.refs).toEqual(["llm-key-0", "llm-key-2"])
    out = await setKeyDenied(kvDenyStore(kv), "llm", "llm-key-0", true)
    expect(out).toEqual({ ok: true, refs: ["llm-key-2"] })

    expect(store.get(`${KEY_DENY_PREFIX}llm`)).toBe("llm-key-2")
    expect(JSON.stringify([...store.entries()])).not.toMatch(/sk-/)
  })

  it("KV 缺失 / 写失败 / ref 非法 → ok:false（fail-open，不抛错、不写入）", async () => {
    expect(await setKeyDenied(undefined, "llm", "llm-key-0", false)).toEqual({ ok: false, refs: [] })

    const { kv, store } = makeKv({ failPut: true })
    expect(await setKeyDenied(kvDenyStore(kv), "llm", "llm-key-0", false)).toEqual({ ok: false, refs: [] })
    expect(store.size).toBe(0)

    const { kv: good, store: goodStore } = makeKv()
    expect(await setKeyDenied(kvDenyStore(good), "llm", "sk-fake-llm-0001", false)).toEqual({ ok: false, refs: [] })
    expect(goodStore.size).toBe(0)
  })
})

// ─────────────────────────── KeyPool denied 过滤 ───────────────────────────

describe("KeyPool 的 denied 过滤（admin 下架 = 运行时效）", () => {
  const env = { EMBED_POOL_KEYS: EMBED_SECRETS.join(",") }

  it("构造注入 denied → pickKey 跳过被禁 ref，availableCount 同步，keys() 仍可查全部", () => {
    const pool = new KeyPool(env, noopDb, { denied: { embed: ["embed-key-0"] } })
    expect(pool.isDenied("embed", "embed-key-0")).toBe(true)
    expect(pool.deniedRefs("embed")).toEqual(["embed-key-0"])
    expect(pool.availableCount("embed")).toBe(1)
    expect(pool.keys("embed")).toHaveLength(2) // 池内仍在（便于 admin 展示/再上架）
    expect(pool.pickKey("embed")!.ref).toBe("embed-key-1")
  })

  it("运行中热更新：setDenied 立刻生效；setDenied(null) 恢复", () => {
    const pool = new KeyPool(env, noopDb)
    expect(pool.pickKey("embed")!.ref).toBe("embed-key-0")
    pool.setDenied("embed", ["embed-key-0"])
    expect(pool.pickKey("embed")!.ref).toBe("embed-key-1")
    pool.setDenied("embed", null)
    expect(pool.deniedRefs("embed")).toEqual([])
    expect(pool.availableCount("embed")).toBe(2)
  })

  it("全部被禁 → pickKey 返回 null（不抛错，交给上层降级）", () => {
    const pool = new KeyPool(env, noopDb, { denied: { embed: ["embed-key-0", "embed-key-1"] } })
    expect(pool.availableCount("embed")).toBe(0)
    expect(pool.pickKey("embed")).toBeNull()
  })

  it("applyDenied 批量注入三个池；默认（不传）等于旧行为", () => {
    const pool = new KeyPool({ ...env, LLM_POOL_KEYS: LLM_SECRETS.join(",") }, noopDb)
    pool.applyDenied({ embed: ["embed-key-1"], llm: ["llm-key-0"], rerank: ["rerank-key-0"] })
    expect(pool.deniedRefs("embed")).toEqual(["embed-key-1"])
    expect(pool.deniedRefs("llm")).toEqual(["llm-key-0"])
    expect(pool.deniedRefs("rerank")).toEqual(["rerank-key-0"])
    expect(pool.pickKey("llm")!.ref).toBe("llm-key-1")

    const fresh = new KeyPool({ ...env, LLM_POOL_KEYS: LLM_SECRETS.join(",") }, noopDb)
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
  const env = { EMBED_POOL_KEYS: EMBED_SECRETS.join(","), EMBEDDING_DIM: "8" }

  it("被禁的 embed-key-0 不会被使用（换用 embed-key-1）", async () => {
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider(env, noopDb, fetchImpl, { denied: { embed: ["embed-key-0"] } })
    const vec = await provider.embed("激素", { kind: "query" })
    expect(vec).toHaveLength(8)
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[1]}`])
  })

  it("fail-open：KV 抛错 → 无禁用 → 仍用第一把 key（检索不受管理面故障影响）", async () => {
    const { kv } = makeKv({ failGet: true })
    const denied = await readDeniedPools(kvDenyStore(kv), env)
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider(env, noopDb, fetchImpl, { denied })
    await provider.embed("激素", { kind: "query" })
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
  })

  it("不传 options（旧调用）行为不变 → 用第一把 key", async () => {
    const { fetchImpl, auths } = makeEmbedFetch()
    const { provider } = createEmbeddingProvider(env, noopDb, fetchImpl)
    await provider.embed("激素", { kind: "query" })
    expect(auths).toEqual([`Bearer ${EMBED_SECRETS[0]}`])
  })
})

describe("createRerankProvider 的 denied 入参", () => {
  const env = { LLM_POOL_KEYS: LLM_SECRETS.join(",") }

  it("被禁的 rerank-key-0 不会被使用", async () => {
    const auths: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      auths.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""))
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { provider } = createRerankProvider(env, noopDb, fetchImpl, { denied: { rerank: ["rerank-key-0"] } })
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
        key_ref: "llm-key-0",
        pool: "llm",
        status: "active",
        success_count: 3,
        failure_count: 1,
        total_cost: 0.5,
        enabled: 1,
        updated_at: 123,
      }),
    ).toEqual({
      key_ref: "llm-key-0",
      pool: "llm",
      status: "active",
      success_count: 3,
      failure_count: 1,
      total_cost: 0.5,
      enabled: true,
      updated_at: 123,
      key_id: "llm-key-0",
      used: 0.5,
      last_used_at: 123,
    })
    const sparse = toAdminKeyRow({ key_ref: "embed-key-0", enabled: 0 })
    expect(sparse.enabled).toBe(false)
    expect(sparse.pool).toBe("embed")
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
      EMBED_POOL_KEYS: EMBED_SECRETS.join(","),
      LLM_POOL_KEYS: LLM_SECRETS.join(","),
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

  it("KV 里禁用 embed-key-0 后：搜索照常成功，且不再使用被禁 key", async () => {
    const { kv } = makeKv({ seed: { [`${KEY_DENY_PREFIX}embed`]: "embed-key-0" } })
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
