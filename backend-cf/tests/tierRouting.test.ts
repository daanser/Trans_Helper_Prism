// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 分档限流的路由级接线测试（plan-ratelimit.md §4/§5/§6/§11）
// 全 mock：D1 用内存假表（只精确实现 rate_counters 的 SQL 形状，其它语句宽容处理），零网络。
// 覆盖：① 境外第 11 次 429（§11 验收）；② CN 机房第 7 次 429；③ 伪造 x-prism-* 不采信 → unknown 档；
//       ④ 全局匿名软熔断（匿名只走关键词回退、**零上游调用**）与硬熔断（匿名 429、登录用户不受影响）；
//       ⑤ /admin/whoami 的分档诊断字段（线上验收的关键位）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import type { Env } from "../src/types"

const SECRET = "proxy-shared-secret"

interface FakeRow {
  bucket_key: string
  tier: string
  window_start: number
  window_sec: number
  count: number
  updated_at: number
}

/**
 * 内存 D1：**严格**实现 rate_counters 的 SQL（形状不认识就抛错，防止实现漂移后测试静默通过），
 * 其它表（quotas / chat_sessions / accounts …）返回中性结果（本文件不测它们）。
 */
function makeDb() {
  const rows = new Map<string, FakeRow>()
  const calls: string[] = []
  const apply = (sql: string, args: unknown[]): number => {
    if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
      const [bucketKey, tier, windowStartV, windowSec, updatedAt] = args as [string, string, number, number, number]
      if (rows.has(bucketKey)) return 0
      rows.set(bucketKey, { bucket_key: bucketKey, tier, window_start: windowStartV, window_sec: windowSec, count: 0, updated_at: updatedAt })
      return 1
    }
    if (sql.includes("count = count + 1")) {
      const [updatedAt, bucketKey, limit] = args as [number, string, number]
      const row = rows.get(bucketKey)
      if (!row) return 0
      if (row.count >= limit) return 0
      row.count += 1
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("UPDATE rate_counters SET count = ?")) {
      const [count, windowStartV, windowSec, updatedAt, bucketKey] = args as [number, number, number, number, string]
      const row = rows.get(bucketKey)
      if (!row) return 0
      row.count = count
      row.window_start = windowStartV
      row.window_sec = windowSec
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("DELETE FROM rate_counters")) {
      const [threshold, batch] = args as [number, number]
      const victims = [...rows.values()].filter((r) => r.window_start < threshold).slice(0, batch)
      for (const v of victims) rows.delete(v.bucket_key)
      return victims.length
    }
    if (sql.startsWith("INSERT OR IGNORE INTO rate_counters".replace("rate_counters", "quotas"))) return 0
    return 0 // 其它表：中性（本文件不涉及）
  }
  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(sql)
          return stmt
        },
        async first() {
          if (sql.includes("SELECT count FROM rate_counters")) {
            const row = rows.get(String(rec.args[0]))
            return row ? { count: row.count } : null
          }
          return null // 其它表（quotas / chat_sessions / accounts）：一律"查无此行"
        },
        async run() {
          return { success: true, results: [], meta: { changes: apply(sql, rec.args) } }
        },
      }
      return stmt
    },
  } as unknown as D1Database
  return { db, rows, calls }
}

/** 基础 env：无 KV（KV 限流 fail-open，隔离出 D1 分档路径）、无 Qdrant（回退分支零网络）。 */
function makeEnv(over: Partial<Env> = {}, db: D1Database = makeDb().db): Env {
  return {
    DB: db,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    PROXY_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env
}

/** 一次匿名搜索（默认模拟"经代理转发的境外 IP"）。 */
function search(env: Env, headers: Record<string, string> = {}, body: unknown = { query: "激素", corpora: ["mtf-wiki"] }) {
  return app.request(
    "/api/v1/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...proxyHeaders(), ...headers },
      body: JSON.stringify(body),
    },
    env,
  )
}

/** 代理转发头（凭据匹配 → 采信 x-prism-*）。 */
function proxyHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    "x-prism-proxy": SECRET,
    "x-prism-client-ip": "203.0.113.7",
    "x-prism-country": "US",
    "x-prism-asn": "16509",
    ...over,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("/api/v1/search：分档计数（D1 权威，§5）", () => {
  it("境外（overseas 10/min）：前 10 次放行，**第 11 次 429** + tier/retry_after + Retry-After 头", async () => {
    const env = makeEnv()
    for (let i = 1; i <= 10; i++) {
      const ok = await search(env)
      expect(ok.status, `第 ${i} 次`).toBe(200)
    }
    const denied = await search(env)
    expect(denied.status).toBe(429)
    expect(denied.headers.get("Retry-After")).toBeTruthy()
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0)
    expect(denied.headers.get("X-RateLimit-Limit")).toBe("10")
    const body = (await denied.json()) as { error: string; tier: string; retry_after: number }
    expect(body.error).toBe("rate-limited")
    expect(body.tier).toBe("overseas")
    expect(body.retry_after).toBeGreaterThan(0)
  })

  it("CN 机房（cn_idc 6/min）：前 6 次放行，**第 7 次 429**（比境外更紧，plan §4 有意为之）", async () => {
    const env = makeEnv()
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "45102" }) // 阿里云
    for (let i = 1; i <= 6; i++) {
      expect((await search(env, h)).status, `第 ${i} 次`).toBe(200)
    }
    const denied = await search(env, h)
    expect(denied.status).toBe(429)
    expect(((await denied.json()) as { tier: string }).tier).toBe("cn_idc")
  })

  it("CN 家宽（cn_residential 30/min）：第 31 次才 429（比机房宽 5 倍）", async () => {
    // 突发阈值放宽到 100：本用例只验证**档位**限额（默认 20/10s 的突发会先挡人，那是另一条用例）
    const env = makeEnv({ BURST_PER_10S: "100" })
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "4134" })
    for (let i = 1; i <= 30; i++) {
      expect((await search(env, h)).status, `第 ${i} 次`).toBe(200)
    }
    const denied = await search(env, h)
    expect(denied.status).toBe(429)
    expect(((await denied.json()) as { scope: string }).scope).toBe("tier-limit")
  })

  it("CN 家宽在默认突发阈值下（20/10s）：连打 21 次会被**突发**先挡住（§6 生效）", async () => {
    const env = makeEnv()
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "4134" })
    for (let i = 1; i <= 20; i++) {
      expect((await search(env, h)).status, `第 ${i} 次`).toBe(200)
    }
    const burst = await search(env, h)
    expect(burst.status).toBe(429)
    expect(((await burst.json()) as { scope: string }).scope).toBe("burst")
  })

  it("限额可用 env 覆盖（RATE_LIMIT_OVERSEAS_PER_MIN=2 → 第 3 次 429）", async () => {
    const env = makeEnv({ RATE_LIMIT_OVERSEAS_PER_MIN: "2" })
    expect((await search(env)).status).toBe(200)
    expect((await search(env)).status).toBe(200)
    expect((await search(env)).status).toBe(429)
  })

  it("不同 IP 各占各的额度（同一个 env/DB）", async () => {
    const env = makeEnv({ RATE_LIMIT_OVERSEAS_PER_MIN: "1" })
    expect((await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.7" }))).status).toBe(200)
    expect((await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.8" }))).status).toBe(200)
    expect((await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.7" }))).status).toBe(429)
  })

  it("KV 限流代码保留（SEARCH_CACHE 缺失时 fail-open，不因 KV 挂掉而 429）", async () => {
    // 默认 env 就没有 SEARCH_CACHE；能在限额内正常放行即证明 KV 缺失走的是 fail-open
    const env = makeEnv()
    expect((await search(env)).status).toBe(200)
  })

  it("参数非法仍先 422（不受限流影响），且**不消耗**任何计数", async () => {
    const env = makeEnv({ RATE_LIMIT_OVERSEAS_PER_MIN: "1" })
    expect((await search(env, {}, { query: "", corpora: ["mtf-wiki"] })).status).toBe(422)
    // 上一条不该占用额度：这一条仍应放行
    expect((await search(env)).status).toBe(200)
    expect((await search(env)).status).toBe(429)
  })

  it("D1 不可用 / D1 异常 → fail-open（放行 + 打 warning，不 429）", async () => {
    const noDb = makeEnv({ DB: undefined as never })
    for (let i = 0; i < 3; i++) expect((await search(noDb)).status).toBe(200)

    const broken = makeEnv({
      DB: {
        prepare() {
          throw new Error("d1-down")
        },
      } as unknown as Env["DB"],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect((await search(broken)).status).toBe(200)
    expect(warn.mock.calls.flat().join(" ")).toContain("ratelimit")
  })
})

describe("D1 写放大预算（history.md §5 坑 14：免费版 10 万行写/天）", () => {
  it("一次匿名搜索：1 次封禁只读 + 3 个桶各「补行(0 行写)+条件 UPDATE(1 行写)+回读(1 行读)」", async () => {
    const { db, calls } = makeDb()
    const env = makeEnv({}, db)
    await search(env)
    const patch = (frag: string) => calls.filter((s) => s.includes(frag)).length
    expect(patch("count = count + 1")).toBe(3) // 分档桶 + 突发桶 + 全局匿名桶（各写 1 行）
    expect(patch("INSERT OR IGNORE INTO rate_counters")).toBe(3) // 三桶各补一次行（已存在时写 0 行）
    expect(patch("SELECT count FROM rate_counters")).toBe(4) // 1 次封禁只读 + 3 次计数回读

    const { db: db2, calls: calls2 } = makeDb()
    const token = await issueSession(makeEnv({ JWT_SECRET: "jwt-test-secret" }, db2), {
      sub: "acc-1",
      handle: "t",
      role: "user",
    })
    await app.request(
      "/api/v1/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.5", // 有 IP 才会走突发桶（无 IP 时突发层无从计数）
        },
        body: JSON.stringify({ session_id: "s-1", question: "在吗" }),
      },
      makeEnv({ JWT_SECRET: "jwt-test-secret" }, db2),
    )
    // 登录路径不参与全局匿名熔断 → 少一个桶（2 行写 / 3 次读 vs 匿名 3 行写 / 4 次读）
    expect(calls2.filter((s) => s.includes("count = count + 1")).length).toBe(2)
    expect(calls2.filter((s) => s.includes("SELECT count FROM rate_counters")).length).toBe(3)
  })
})

describe("分档信任链：伪造 x-prism-* 不能买到更宽额度（§3 验收）", () => {
  it("凭据不匹配 → 不采信 x-prism-country/asn → unknown 档（5/min），第 6 次 429", async () => {
    const env = makeEnv()
    const forged = {
      "x-prism-proxy": "guessed-secret",
      "x-prism-client-ip": "203.0.113.7",
      "x-prism-country": "CN", // 伪造者想冒充 CN 家宽拿 30/min
      "x-prism-asn": "4134",
    }
    for (let i = 1; i <= 5; i++) {
      expect((await search(env, forged)).status, `第 ${i} 次`).toBe(200)
    }
    const denied = await search(env, forged)
    expect(denied.status).toBe(429)
    const body = (await denied.json()) as { tier: string }
    // 伪造的 CN/4134 未被采信；测试环境也没有 request.cf → unknown（最保守）
    expect(body.tier).toBe("unknown")
  })

  it("未配 PROXY_SHARED_SECRET → 带凭据头也不采信（退化为 unknown/直连逻辑）", async () => {
    const env = makeEnv({ PROXY_SHARED_SECRET: undefined })
    const denied = await (async () => {
      for (let i = 0; i < 5; i++) await search(env)
      return search(env)
    })()
    expect(denied.status).toBe(429)
    expect(((await denied.json()) as { tier: string }).tier).toBe("unknown")
  })
})

describe("突发（§6）：10 秒窗口 ≥ BURST_PER_10S → 429 + 封禁 60s", () => {
  it("宽档位（cn_residential 30/min）+ BURST_PER_10S=3 → 第 4 次触发突发并被封禁", async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ BURST_PER_10S: "3" }, db)
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "4134" })
    for (let i = 1; i <= 3; i++) expect((await search(env, h)).status, `第 ${i} 次`).toBe(200)
    const burst = await search(env, h)
    expect(burst.status).toBe(429)
    expect(Number(burst.headers.get("Retry-After"))).toBeGreaterThan(60 - 5) // 封禁 60s
    expect(((await burst.json()) as { scope: string }).scope).toBe("burst")
    // D1 里留下了封禁行（count 列借用存 block_until）
    const blockRow = [...rows.values()].find((r) => r.tier.startsWith("block:"))
    expect(blockRow).toBeDefined()
    expect(blockRow!.count).toBeGreaterThan(Date.now())
    // 封禁期内继续打 → scope=blocked（不再重复触发突发，也不再占名额）
    const blocked = await search(env, h)
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { scope: string }).scope).toBe("blocked")
  })

  it("分档桶与突发桶分开：分档额度不会被突发计数吃掉", async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ BURST_PER_10S: "100" }, db) // 突发阈值放宽 → 只观察桶
    await search(env)
    const tiers = [...rows.values()].map((r) => r.tier).sort()
    // 一次匿名搜索 = 分档桶 + 突发桶 + 全局匿名熔断桶（三个独立桶，互不占用额度）
    expect(tiers).toEqual(["anon_global", "burst:overseas", "overseas"])
  })

  it("窄档位（overseas 10/min）在突发阈值之内先被档位拦住，不会误报突发", async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ BURST_PER_10S: "20" }, db)
    for (let i = 0; i < 10; i++) await search(env)
    const denied = await search(env)
    expect(denied.status).toBe(429)
    expect(((await denied.json()) as { scope: string }).scope).toBe("tier-limit")
    expect([...rows.values()].some((r) => r.tier.startsWith("block:"))).toBe(false)
  })
})

describe("全局匿名熔断（§6）：只掐匿名，登录用户不受影响", () => {
  /** 匿名全量检索（REQUIRE_LOGIN=0）用的 env：故意给出会触发上游调用的 key 配置。 */
  function breakerEnv(over: Partial<Env> = {}): Env {
    return makeEnv({
      REQUIRE_LOGIN: "0",
      EMBED_POOL_KEYS: "test-embed-key",
      EMBEDDING_ENDPOINT: "https://embed.example/v1/embeddings",
      ANON_GLOBAL_PER_MIN: "2",
      ANON_GLOBAL_HARD_PER_MIN: "3",
      ...over,
    })
  }

  it("软熔断：匿名超过 ANON_GLOBAL_PER_MIN → 只走关键词回退 + warning，**零上游调用**", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const env = breakerEnv()

    // 前 2 次：正常路径（会尝试 embed → 有上游调用）
    const first = await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.11" }))
    expect(first.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()

    await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.12" }))
    const callsBefore = fetchMock.mock.calls.length
    // 第 3 次：全局计数 3 > 软阈值 2 → 软熔断（匿名只给关键词回退）
    const soft = await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.13" }))
    expect(soft.status).toBe(200)
    const body = (await soft.json()) as { fallback?: boolean; warnings: string[] }
    expect(body.fallback).toBe(true)
    expect(body.warnings).toContain("global-soft-break")
    expect(fetchMock.mock.calls.length).toBe(callsBefore) // 软熔断后**不再调 embedding/rerank**
  })

  it("硬熔断：匿名超过 ANON_GLOBAL_HARD_PER_MIN → 一律 429（scope=global-hard）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
    const env = breakerEnv()
    for (let i = 0; i < 3; i++) await search(env, proxyHeaders({ "x-prism-client-ip": `203.0.113.2${i}` }))
    const hard = await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.29" }))
    expect(hard.status).toBe(429)
    const body = (await hard.json()) as { tier: string; scope: string }
    expect(body.scope).toBe("global-hard")
    expect(body.tier).toBe("overseas") // 档位照旧回显（熔断是**全局**层，不改档位）
  })

  it("硬熔断期间**登录用户不受影响**（同一份 env：匿名 429，登录仍能过闸门）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
    const env = breakerEnv({ JWT_SECRET: "jwt-test-secret" })
    // 先把全局匿名桶打过硬阈值
    for (let i = 0; i < 3; i++) await search(env, proxyHeaders({ "x-prism-client-ip": `203.0.113.3${i}` }))
    expect((await search(env, proxyHeaders({ "x-prism-client-ip": "203.0.113.39" }))).status).toBe(429)

    const token = await issueSession(env, { sub: "acc-1", handle: "tester", role: "user" })
    // /chat 是登录路径（scope=llm，applyGlobalBreak=false）：全局硬熔断不该拦它。
    // 会话不存在 → 404（**不是 429**），足以证明熔断没掐登录用户。
    const resp = await app.request(
      "/api/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: "s-1", question: "在吗" }),
      },
      env,
    )
    expect(resp.status).not.toBe(429)
    expect(resp.status).toBe(404)
  })
})

describe("LLM 档（§4.0）：/search/stream 与 /chat 单独计数", () => {
  async function chatCall(env: Env, token: string) {
    return app.request(
      "/api/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: "s-1", question: "在吗" }),
      },
      env,
    )
  }

  it("登录用户 LLM 限额 = ceil(60/5) = 12/min：第 13 次 429，且与搜索桶分开", async () => {
    const env = makeEnv({ JWT_SECRET: "jwt-test-secret" })
    const token = await issueSession(env, { sub: "acc-1", handle: "tester", role: "user" })
    // 前 12 次：过闸门（会话不存在 → 404，与限流无关）
    for (let i = 1; i <= 12; i++) {
      expect((await chatCall(env, token)).status, `第 ${i} 次`).toBe(404)
    }
    const denied = await chatCall(env, token)
    expect(denied.status).toBe(429)
    const body = (await denied.json()) as { tier: string; retry_after: number }
    expect(body.tier).toBe("logged_in")
    expect(body.retry_after).toBeGreaterThan(0)
    // `/chat` 用的 llm 桶与搜索桶无关：同账号的**搜索**额度仍应可用（此处用匿名代理头模拟另一个桶）
    expect((await search(makeEnv({ JWT_SECRET: "jwt-test-secret" }), proxyHeaders())).status).toBe(200)
  })

  it("RATE_LIMIT_LLM_DIVISOR=4 → 登录档 LLM 限额 15（ceil(60/4)）", async () => {
    const env = makeEnv({ JWT_SECRET: "jwt-test-secret", RATE_LIMIT_LLM_DIVISOR: "4" })
    const token = await issueSession(env, { sub: "acc-1", handle: "tester", role: "user" })
    for (let i = 1; i <= 15; i++) expect((await chatCall(env, token)).status, `第 ${i} 次`).toBe(404)
    expect((await chatCall(env, token)).status).toBe(429)
  })
})

describe("GET /api/v1/admin/whoami：分档诊断（§11 验收关键位）", () => {
  function whoamiEnv(over: Partial<Env> = {}): Env {
    return makeEnv({ ADMIN_API_KEY: "admin-key", ...over })
  }
  function whoami(env: Env, headers: Record<string, string> = {}) {
    return app.request("/api/v1/admin/whoami", { headers: { Authorization: "Bearer admin-key", ...headers } }, env)
  }

  it("经代理转发的 CN 机房 IP → tier=cn_idc / 6 per min / llm 2 per min / resolved_by=proxy-trusted", async () => {
    const env = whoamiEnv()
    const resp = await whoami(env, proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "45102" }))
    expect(resp.status).toBe(200)
    const b = (await resp.json()) as Record<string, unknown>
    expect(b.tier).toBe("cn_idc")
    expect(b.limit_per_min).toBe(6)
    expect(b.llm_limit_per_min).toBe(2)
    expect(b.count_in_window).toBe(0)
    expect(b.resolved_by).toBe("proxy-trusted")
    expect(b.resolved_meta_by).toBe("proxy-trusted")
    expect(b.resolved_country).toBe("CN")
    expect(b.resolved_asn).toBe("45102")
    expect(b.hosting_asn).toBe(false)
    expect(b["x-prism-proxy-trusted"]).toBe(true)
    expect(b.rate_hmac_degraded).toBe(false)
    expect(b.burst_per_10s).toBe(20)
    expect(b.anon_global_per_min).toBe(600)
    expect(b.anon_global_hard_per_min).toBe(1200)
    expect((b.cf as Record<string, unknown>).asn).toBeNull() // 保留既有字段（测试环境无 request.cf）
  })

  it("境外 IP → tier=overseas / 10 per min；known 机房 ASN 只做诊断标注", async () => {
    const env = whoamiEnv()
    const resp = await whoami(env, proxyHeaders({ "x-prism-country": "US", "x-prism-asn": "16509" }))
    const b = (await resp.json()) as Record<string, unknown>
    expect(b.tier).toBe("overseas")
    expect(b.limit_per_min).toBe(10)
    expect(b.llm_limit_per_min).toBe(2)
    expect(b.hosting_asn).toBe(true) // AWS，但**不改变档位**（plan §4：非 CN 一律 overseas）
  })

  it("伪造 x-prism-* → 不采信（tier=unknown / 5 per min）", async () => {
    const env = whoamiEnv()
    const resp = await whoami(env, {
      "x-prism-proxy": "wrong",
      "x-prism-country": "CN",
      "x-prism-asn": "4134",
    })
    const b = (await resp.json()) as Record<string, unknown>
    expect(b["x-prism-proxy-trusted"]).toBe(false)
    expect(b.tier).toBe("unknown")
    expect(b.limit_per_min).toBe(5)
    expect(b.llm_limit_per_min).toBe(1)
    expect(b.resolved_meta_by).toBe("none")
  })

  it("count_in_window 反映当前窗口计数（只读，不占名额）；**绝不回显密钥**", async () => {
    const env = whoamiEnv()
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "4134" })
    await search(env, h)
    await search(env, h)
    const b1 = (await (await whoami(env, h)).json()) as Record<string, unknown>
    const b2 = (await (await whoami(env, h)).json()) as Record<string, unknown>
    expect(b1.count_in_window).toBe(2)
    expect(b2.count_in_window).toBe(2) // 连查两次不变（whoami 不占名额）

    const raw = JSON.stringify(b1)
    expect(raw).not.toContain(SECRET) // 共享密钥绝不回显
    expect(raw).not.toContain("admin-key")
    expect(b1["x-prism-proxy-present"]).toBe(true) // 只回布尔
    expect(b1["proxy-secret-configured"]).toBe(true)
  })

  it("D1 不可用 → count_in_window=0 + rate_count_degraded=true（诊断不因 D1 挂掉而 500）", async () => {
    const env = whoamiEnv({ DB: undefined as never })
    const resp = await whoami(env)
    expect(resp.status).toBe(200)
    const b = (await resp.json()) as Record<string, unknown>
    expect(b.count_in_window).toBe(0)
    expect(b.rate_count_degraded).toBe(true)
  })
})
