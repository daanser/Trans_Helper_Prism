// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Key Pool 单测 (tasks.md T0.2；2026-09-12 合并池重构 plan-keypool.md)
// 覆盖：
//   1) 第一个 key 401 → 自动换第二个 key 成功（withKeyRetry 换 key 重试）
//   2) 超长文本截断不抛错（embedding 的 buildInput 截断）
//   3) **合并池**：`POOL_KEYS_<n>` 前缀扫描、ref=`pool-key-<n>` 稳定、逗号多把、去重、LRU 轮转、禁用全能力
import { describe, it, expect, vi } from "vitest"
import {
  KeyPool,
  withKeyRetry,
  KeyPoolDb,
  PoolKey,
  parseMergedKeys,
  scanPoolKeyVars,
  shouldRetryStatus,
} from "../src/keypool"
import { SiliconFlowEmbedding } from "../src/embeddings"
import { commaPoolKeyEnv, poolKeysEnv } from "./poolKeysEnv"

/** 内存版 D1 记账 mock。 */
function makeDb(): KeyPoolDb & { usage: unknown[]; failures: unknown[] } {
  const usage: unknown[] = []
  const failures: unknown[] = []
  return {
    usage,
    failures,
    async recordUsage(rec) {
      usage.push(rec)
    },
    async markFailure(pool, keyRef, reason) {
      failures.push({ pool, keyRef, reason })
    },
  }
}

/** 构造一个带两把 key 的池（合并池后 embed/llm/rerank 指向同一份）。 */
function makePool() {
  const db = makeDb()
  const pool = new KeyPool(poolKeysEnv(["sk-first", "sk-second"]), db)
  return { pool, db }
}

/** 可逐次注入响应的 fetch mock。每次调用从队列取出下一个响应；空则一直用最后一个。 */
function makeResponseQueue(): { queue: Array<{ ok: boolean; status: number }>; fetchImpl: typeof fetch } {
  const queue: Array<{ ok: boolean; status: number }> = []
  const fetchImpl = vi.fn(async (_url: any, _init?: any) => {
    const next = queue.length > 0 ? queue.shift()! : queue[queue.length - 1] ?? { ok: true, status: 200 }
    return {
      ok: next.ok,
      status: next.status,
      json: async () => ({ data: [{ embedding: new Array(1024).fill(0.1) }] }),
      text: async () => "",
    } as Response
  }) as unknown as typeof fetch
  return { queue, fetchImpl }
}

describe("KeyPool / withKeyRetry", () => {
  it("第一个 key 401 时自动换第二个 key 并成功", async () => {
    const { pool, db } = makePool()
    const { queue, fetchImpl } = makeResponseQueue()
    // 第一次尝试（key-0）：401；第二次尝试（key-1）：200
    queue.push({ ok: false, status: 401 }, { ok: true, status: 200 })

    const attempts: string[] = []
    const resp = await withKeyRetry(pool, "embed", async (key: PoolKey) => {
      attempts.push(key.secret)
      return fetchImpl("https://api.siliconflow.cn/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.secret}` },
      })
    })

    expect(resp.ok).toBe(true)
    expect(resp.status).toBe(200)
    // 确实用了两个不同的 key
    expect(attempts).toEqual(["sk-first", "sk-second"])
    // 第一个 key 401 后进入冷却，所以当前可用只有第二个（1 个）；冷却 5s 后会恢复
    expect(pool.availableCount("embed")).toBe(1)
    const first = pool.keys("embed").find((k) => k.ref === "pool-key-0")!
    expect(first.consecutiveFailures).toBe(1)
    expect(first.cooldownUntil).toBeGreaterThan(Date.now())
    expect(db.failures.length).toBe(1)
  })

  it("应换 key 的状态码判定正确", () => {
    expect(shouldRetryStatus(401)).toBe(true)
    expect(shouldRetryStatus(403)).toBe(true)
    expect(shouldRetryStatus(429)).toBe(true)
    expect(shouldRetryStatus(402)).toBe(true)
    expect(shouldRetryStatus(200)).toBe(false)
    expect(shouldRetryStatus(400)).toBe(false)
  })

  it("pool 无可用 key 时抛错给上层降级", async () => {
    const { pool } = makePool()
    // 把两个 key 都剔除
    await pool.reportFailure("embed", "pool-key-0", "x")
    await pool.reportFailure("embed", "pool-key-1", "x")
    await pool.reportFailure("embed", "pool-key-0", "x")
    await pool.reportFailure("embed", "pool-key-1", "x")
    await pool.reportFailure("embed", "pool-key-0", "x")
    await pool.reportFailure("embed", "pool-key-1", "x")
    await pool.reportFailure("embed", "pool-key-0", "x")
    await pool.reportFailure("embed", "pool-key-1", "x")
    await pool.reportFailure("embed", "pool-key-0", "x")
    await pool.reportFailure("embed", "pool-key-1", "x")
    expect(pool.availableCount("embed")).toBe(0)
    await expect(
      withKeyRetry(pool, "embed", async (key) => fetch("http://x", { headers: { Authorization: `B ${key.secret}` } })),
    ).rejects.toThrow(/无可用 key/)
  })

  it("连续失败达到阈值后剔除 key", async () => {
    const { pool } = makePool()
    // 连续 5 次失败 → evicted
    for (let i = 0; i < 5; i++) {
      await pool.reportFailure("embed", "pool-key-0", "upstream-429")
    }
    const k = pool.keys("embed").find((x) => x.ref === "pool-key-0")!
    expect(k.evicted).toBe(true)
    expect(pool.availableCount("embed")).toBe(1)
  })
})

// ── 合并池重构守卫（plan-keypool.md §2.1/§2.2/§2.3/§2.5）──
describe("POOL_KEYS_<n> 解析：升序 / ref 稳定 / 逗号多把 / 去重", () => {
  it("按数字升序收集（_0 在前，不要求连续）；忽略非法名与非字符串值", () => {
    const vars = scanPoolKeyVars({
      POOL_KEYS_2: "c",
      POOL_KEYS_0: "a",
      POOL_KEYS_10: "k", // 两位数也要按数值排序（不能按字典序）
      POOL_KEYS_X: "bad", // 非法名忽略
      POOL_KEYS_: "bad", // 非法名忽略
      POOL_KEYS_3: 123, // 非字符串忽略
      SOME_OTHER_KEYS: "非 POOL_KEYS_ 前缀的变量一律忽略",
    })
    expect(vars.map((v) => v.index)).toEqual([0, 2, 10])
    expect(vars.map((v) => v.raw)).toEqual(["a", "c", "k"])
    expect(parseMergedKeys({ POOL_KEYS_2: "c", POOL_KEYS_0: "a" }).map((k) => k.ref)).toEqual(["pool-key-0", "pool-key-2"])
  })

  it("**ref 稳定**：删掉 POOL_KEYS_1 后 pool-key-0 / pool-key-2 不变（旧实现按索引会移位）", () => {
    const before = parseMergedKeys({ POOL_KEYS_0: "sk-0", POOL_KEYS_1: "sk-1", POOL_KEYS_2: "sk-2" })
    expect(before.map((k) => k.ref)).toEqual(["pool-key-0", "pool-key-1", "pool-key-2"])
    expect(before.map((k) => k.secret)).toEqual(["sk-0", "sk-1", "sk-2"])

    const after = parseMergedKeys({ POOL_KEYS_0: "sk-0", POOL_KEYS_2: "sk-2" }) // 删掉中间那把
    expect(after.map((k) => k.ref)).toEqual(["pool-key-0", "pool-key-2"])
    // 关键断言：剩下两把的 ref **一个字符都没变**（禁用集/ provider_keys 表按 ref 记录，错位=误伤/误放）
    for (const ref of ["pool-key-0", "pool-key-2"]) {
      const b = before.find((k) => k.ref === ref)!
      const a = after.find((k) => k.ref === ref)!
      expect(a.secret).toBe(b.secret)
    }
  })

  it("一个变量里逗号多把：首把 pool-key-<n>，其后 pool-key-<n>#2 / #3", () => {
    const keys = parseMergedKeys(commaPoolKeyEnv(["sk-a", "sk-b", "sk-c"], 3))
    expect(keys.map((k) => k.ref)).toEqual(["pool-key-3", "pool-key-3#2", "pool-key-3#3"])
    expect(keys.map((k) => k.secret)).toEqual(["sk-a", "sk-b", "sk-c"])
  })

  it("同一把 key 配了多次 → 去重并 warn（保留数字更小的 ref，warn 里不含 key 值）", () => {
    const warns: string[] = []
    const keys = parseMergedKeys(
      { POOL_KEYS_1: "sk-dup", POOL_KEYS_0: "sk-dup", POOL_KEYS_2: "sk-other" },
      (m) => warns.push(m),
    )
    // 升序遍历 → _0 先入池，_1 的重复值被丢弃
    expect(keys.map((k) => k.ref)).toEqual(["pool-key-0", "pool-key-2"])
    expect(keys.map((k) => k.secret)).toEqual(["sk-dup", "sk-other"])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("pool-key-1")
    expect(warns[0]).toContain("保留 pool-key-0")
    expect(warns[0]).not.toContain("sk-dup") // 绝不含 key 值
  })

  it("空 env / 未配置 → 空池（不抛错）", () => {
    expect(parseMergedKeys({})).toEqual([])
    expect(parseMergedKeys({ POOL_KEYS_0: " , , " })).toEqual([])
    expect(parseMergedKeys(null)).toEqual([])
  })
})

describe("合并池语义：一个池、三个能力入口、禁用全能力", () => {
  it("pickKey 的三个能力入口指向**同一份 key 对象**（in-flight/禁用共享）", () => {
    const pool = new KeyPool(poolKeysEnv(["sk-a"]), makeDb())
    const viaEmbed = pool.pickKey("embed")!
    expect(viaEmbed.ref).toBe("pool-key-0")
    // 从 llm 入口再取：因为 in-flight 已 +1（同一对象），所以这里仍是同一把但不是"另一份列表"
    const viaLlm = pool.pickKey("llm")!
    expect(viaLlm).toBe(viaEmbed)
    pool.releaseKey("embed", viaEmbed.ref)
    pool.releaseKey("llm", viaLlm.ref)
    // 三个入口看到同一份列表（同一批对象）
    expect(pool.keys("embed")).toBe(pool.keys("rerank"))
    expect(pool.availableCount("embed")).toBe(pool.availableCount("llm"))
  })

  it("禁用一把 key = **全能力禁用**（embed/rerank/llm 三个入口都取不到它）", () => {
    const pool = new KeyPool(poolKeysEnv(["sk-a", "sk-b"]), makeDb())
    pool.setDenied("llm", ["pool-key-0"]) // 从任一能力入口禁，都作用于整池
    expect(pool.isDenied("embed", "pool-key-0")).toBe(true)
    expect(pool.isDenied("rerank", "pool-key-0")).toBe(true)
    expect(pool.isDenied("llm", "pool-key-0")).toBe(true)
    expect(pool.deniedRefs("embed")).toEqual(["pool-key-0"])
    for (const ability of ["embed", "llm", "rerank"] as const) {
      expect(pool.pickKey(ability)!.ref, ability).toBe("pool-key-1")
    }
  })
})

describe("负载均衡：并列时按 LRU 轮转（修「顺序请求只打第一把」）", () => {
  it("连续 10 次顺序取用（每次 release）→ 两把各 5 次（改前是 10/0）", () => {
    const pool = new KeyPool(poolKeysEnv(["sk-a", "sk-b"]), makeDb())
    const picks: string[] = []
    for (let i = 0; i < 10; i++) {
      const k = pool.pickKey("embed")!
      picks.push(k.ref)
      pool.releaseKey("embed", k.ref) // 顺序请求：用完即释放
    }
    const count0 = picks.filter((r) => r === "pool-key-0").length
    const count1 = picks.filter((r) => r === "pool-key-1").length
    expect(count0).toBe(5)
    expect(count1).toBe(5)
    // 真·轮转（交替），不是"先打满一把再换"
    expect(picks).toEqual([
      "pool-key-0",
      "pool-key-1",
      "pool-key-0",
      "pool-key-1",
      "pool-key-0",
      "pool-key-1",
      "pool-key-0",
      "pool-key-1",
      "pool-key-0",
      "pool-key-1",
    ])
  })

  it("并发场景仍优先最少在用（in-flight 优先于 LRU）", () => {
    const pool = new KeyPool(poolKeysEnv(["sk-a", "sk-b"]), makeDb())
    const a = pool.pickKey("embed")! // pool-key-0（in-flight=1，不释放）
    const b = pool.pickKey("embed")! // 选 in-flight 更少的 pool-key-1
    expect(a.ref).toBe("pool-key-0")
    expect(b.ref).toBe("pool-key-1")
  })

  it("三把 key → 顺序取用均匀轮转（3/3/4 型分布）", () => {
    const pool = new KeyPool(poolKeysEnv(["sk-a", "sk-b", "sk-c"]), makeDb())
    const picks: string[] = []
    for (let i = 0; i < 9; i++) {
      const k = pool.pickKey("embed")!
      picks.push(k.ref)
      pool.releaseKey("embed", k.ref)
    }
    const counts = new Map<string, number>()
    for (const r of picks) counts.set(r, (counts.get(r) ?? 0) + 1)
    expect([...counts.values()]).toEqual([3, 3, 3])
  })
})

describe("SiliconFlowEmbedding 超长截断", () => {
  it("超长文本截断不抛错，且发送的是截断后的文本", async () => {
    const db = makeDb()
    const pool = new KeyPool(poolKeysEnv(["sk-a", "sk-b"]), db)
    const provider = new SiliconFlowEmbedding(
      { model: "BAAI/bge-m3", dim: 1024, endpoint: "https://api.siliconflow.cn/v1/embeddings" },
      pool,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(Array.isArray(body.input)).toBe(false)
        // 输出去掉 instruction 后长度 <= 8000（截断而不抛错）
        expect(String(body.input).length).toBeLessThanOrEqual(8000)
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: new Array(1024).fill(0.5) }] }),
        } as Response
      },
    )

    const vec = await provider.embed("x".repeat(50_000), { kind: "document" })
    expect(vec).toHaveLength(1024)
  })

  it("模型维度不匹配时抛错（避免污染向量库）", async () => {
    const db = makeDb()
    const pool = new KeyPool(poolKeysEnv(["sk-a"]), db)
    const provider = new SiliconFlowEmbedding(
      { model: "BAAI/bge-m3", dim: 1024 },
      pool,
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: new Array(768).fill(0.5) }] }),
        } as Response),
    )
    await expect(provider.embed("测试")).rejects.toThrow(/dim-mismatch/)
  })
})
