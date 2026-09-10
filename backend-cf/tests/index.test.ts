// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — index.ts 路由接线单测 (tasks.md T2.2/T2.4)
// 全 mock fetch（Qdrant collection info / scroll），验证 /api/v1/corpora、/api/v1/tree/:wiki_id 的
// 200/422/404 路径与 queue consumer 的 wikiId 分发。绝不调真实上游。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { app } from "../src/index"
import type { Env } from "../src/types"

/** 最小 Env（无 DB/queue 也不崩：路由只读 env.QDRANT_* 与 registry）。 */
function makeEnv(qdrant = true): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    QDRANT_URL: qdrant ? "https://qdrant.example" : undefined,
    QDRANT_API_KEY: "qdrant-test-key",
  } as unknown as Env
}

/** fetch mock：collection info + scroll。 */
function makeFetchMock(): { fetchImpl: typeof fetch } {
  const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url)
    if (u.includes("/collections/") && u.endsWith("/points/scroll")) {
      return new Response(
        JSON.stringify({
          result: {
            points: [
              {
                payload: {
                  title: "激素治疗",
                  section_path: "治疗/激素",
                  path: "p1",
                  url: "https://u/1",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              },
              {
                payload: {
                  title: "术后护理",
                  section_path: "手术/术后",
                  path: "p2",
                  url: "https://u/2",
                  updated_at: "2026-01-02T00:00:00Z",
                },
              },
            ],
            next_page_offset: null,
          },
        }),
        { status: 200 },
      )
    }
    // /collections/{name} GET → points_count
    return new Response(JSON.stringify({ result: { points_count: 42 } }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl }
}

describe("GET /api/v1/corpora", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("返回四库 corpora，chunk_count 来自 Qdrant points_count", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ id: string; chunk_count: number; name: string }> }
    expect(body.corpora).toHaveLength(4)
    const mtf = body.corpora.find((c) => c.id === "mtf-wiki")!
    expect(mtf.chunk_count).toBe(42)
    expect(mtf.name).toBe("MtF Wiki")
  })

  it("Qdrant 未配置 → 仍返回 200，chunk_count 归零", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv(false))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ chunk_count: number }> }
    expect(body.corpora.every((c) => c.chunk_count === 0)).toBe(true)
    // 未配置 Qdrant 时不该发任何网络请求
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/tree/:wiki_id", () => {
  it("合法 wiki → 200 + 树（按 section_path 聚合）", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { wiki_id: string; tree: Array<{ title: string; children: unknown[] }> }
    expect(body.wiki_id).toBe("mtf-wiki")
    expect(body.tree.length).toBeGreaterThan(0)
    expect(body.tree[0].children.length).toBeGreaterThan(0) // 治疗/激素 是 治疗 → 激素 两级的子节点
  })

  it("非法 wiki → 422", async () => {
    const resp = await app.request("/api/v1/tree/not-a-wiki", {}, makeEnv())
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-corpus" })
  })

  it("Qdrant 未配置 → 502", async () => {
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv(false))
    expect(resp.status).toBe(502)
  })
})

// ── /api/v1/admin/ingest/trigger（T2.2 运维入口）──
describe("POST /api/v1/admin/ingest/trigger", () => {
  function adminEnv(): Env {
    const del = vi.fn(async () => ({}))
    const send = vi.fn(async () => undefined)
    return {
      DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: del })) })),
      } as unknown as Env["DB"],
      INGEST_QUEUE: { send } as unknown as Env["INGEST_QUEUE"],
      ADMIN_API_KEY: "admin-secret",
      SEARCH_CACHE: undefined as never,
      QDRANT_URL: undefined,
    } as unknown as Env
  }

  it("未配置 ADMIN_API_KEY → 503", async () => {
    const env = { ...adminEnv(), ADMIN_API_KEY: undefined as never } as Env
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=mtf-wiki",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "admin-key-unconfigured" })
  })

  it("无 Authorization 或错误 key → 401", async () => {
    const env = adminEnv()
    let resp = await app.request("/api/v1/admin/ingest/trigger", { method: "POST" }, env)
    expect(resp.status).toBe(401)
    resp = await app.request(
      "/api/v1/admin/ingest/trigger",
      { method: "POST", headers: { Authorization: "Bearer wrong" } },
      env,
    )
    expect(resp.status).toBe(401)
  })

  it("合法 key + 触发全部 wiki → 对每个发 Queue 消息", async () => {
    const env = adminEnv()
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { sent: string[] }
    expect(body.sent.length).toBe(4) // mtf / ftm / rle / mio
    expect((env.INGEST_QUEUE.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4)
  })

  it("reset=1 → 清 D1 两张表 + 投递", async () => {
    const env = adminEnv()
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=mtf-wiki&reset=1",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { reset: Record<string, string> }
    expect(body.reset["mtf-wiki"]).toBe("ok")
    // DB.prepare 被调用两次（ingest_runs 删除 + ingest_files 删除）
    const prep = (env.DB.prepare as ReturnType<typeof vi.fn>)
    expect(prep).toHaveBeenCalledTimes(2)
    expect((env.INGEST_QUEUE.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("非法 wiki_id → 422", async () => {
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=not-a-wiki",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      adminEnv(),
    )
    expect(resp.status).toBe(422)
  })
})

// ── /api/v1/admin/whoami（诊断：反代后的客户端 IP 信任链）──
describe("GET /api/v1/admin/whoami", () => {
  const SECRET = "proxy-secret-xyz"
  /** 线上实测：经 Pages 反代后 CF 给子请求注入的内部地址。 */
  const INTERNAL = "2a06:98c0:3600::103"

  function whoamiEnv(secret?: string): Env {
    return {
      DB: undefined as never,
      SEARCH_CACHE: undefined as never,
      INGEST_QUEUE: undefined as never,
      ADMIN_API_KEY: "admin-secret",
      PROXY_SHARED_SECRET: secret,
    } as unknown as Env
  }

  async function call(env: Env, headers: Record<string, string>) {
    const resp = await app.request(
      "/api/v1/admin/whoami",
      { headers: { Authorization: "Bearer admin-secret", ...headers } },
      env,
    )
    expect(resp.status).toBe(200)
    return (await resp.json()) as Record<string, unknown>
  }

  it("未配置密钥 → 退化直连逻辑，且**绝不回显**任何密钥", async () => {
    const body = await call(whoamiEnv(), {
      "cf-connecting-ip": INTERNAL,
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": SECRET,
    })
    expect(body["proxy-secret-configured"]).toBe(false)
    expect(body["x-prism-proxy-present"]).toBe(true) // 头到了
    expect(body["x-prism-proxy-trusted"]).toBe(false) // 但没配密钥 → 不采信
    expect(body.resolved_ip).toBe(INTERNAL)
    expect(body.resolved_by).toBe("cf-connecting-ip")
    // 安全：整个响应体里不能出现密钥值
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it("密钥匹配 → resolved_by=proxy-trusted，采信 x-prism-client-ip", async () => {
    const body = await call(whoamiEnv(SECRET), {
      "cf-connecting-ip": INTERNAL,
      "x-forwarded-for": "203.0.113.7",
      "x-prism-client-ip": "203.0.113.7",
      "x-prism-proxy": SECRET,
    })
    expect(body["proxy-secret-configured"]).toBe(true)
    expect(body["x-prism-proxy-present"]).toBe(true)
    expect(body["x-prism-proxy-trusted"]).toBe(true)
    expect(body["x-prism-client-ip"]).toBe("203.0.113.7")
    expect(body.resolved_ip).toBe("203.0.113.7")
    expect(body.resolved_by).toBe("proxy-trusted")
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it("密钥不匹配（两边配了不同的值）→ present=true 但 trusted=false，退回 cf-connecting-ip", async () => {
    const body = await call(whoamiEnv(SECRET), {
      "cf-connecting-ip": INTERNAL,
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": "another-secret",
    })
    expect(body["x-prism-proxy-present"]).toBe(true)
    expect(body["x-prism-proxy-trusted"]).toBe(false)
    expect(body.resolved_ip).toBe(INTERNAL)
    expect(body.resolved_by).toBe("cf-connecting-ip")
  })

  it("无任何来源头 → resolved_by=none；仍需 admin 鉴权", async () => {
    const body = await call(whoamiEnv(SECRET), {})
    expect(body.resolved_ip).toBe(null)
    expect(body.resolved_by).toBe("none")

    const denied = await app.request("/api/v1/admin/whoami", {}, whoamiEnv(SECRET))
    expect(denied.status).toBe(401)
  })
})