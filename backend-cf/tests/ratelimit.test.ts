// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 限流单测（tasks.md T3.3）
// 全 mock：内存 KV（带 TTL 过期模拟），时间由 nowMs 注入，零网络、零真实 key。
// 覆盖：窗口内拒绝 / 窗口过期放行 / KV 缺失或异常 fail-open / IP 匿名化 / 双维度组合策略。
import { describe, it, expect } from "vitest"
import {
  checkRateLimit,
  checkSubjectRateLimit,
  clientIpFromHeaders,
  fnv1aHex,
  ipKey,
  accountKey,
  kvRateLimitStore,
  PROXY_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  resolveClientIp,
  timingSafeEqualString,
  windowIndexFor,
  windowedKey,
  rateLimitHeaders,
  DEFAULT_RATE_LIMIT_POLICY,
  type RateLimitStore,
} from "../src/ratelimit"

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0)

/** 内存 KV：支持 TTL 过期（exp 以绝对 ms 记录）。 */
function makeStore(nowRef: { now: number }) {
  const map = new Map<string, { v: string; exp: number }>()
  const store: RateLimitStore = {
    async get(key) {
      const e = map.get(key)
      if (!e) return null
      if (e.exp <= nowRef.now) {
        map.delete(key)
        return null
      }
      return e.v
    },
    async put(key, value, options) {
      map.set(key, { v: value, exp: nowRef.now + (options?.expirationTtl ?? 0) * 1000 })
    },
  }
  return { store, map }
}

describe("key 构造与隐私", () => {
  it("ipKey 确定性、不同 IP 不同桶，且**不含 IP 明文**", () => {
    const a = ipKey("203.0.113.7")
    const b = ipKey("203.0.113.8")
    expect(a).toBe(ipKey("203.0.113.7"))
    expect(a).not.toBe(b)
    expect(a.startsWith("rl:ip:")).toBe(true)
    expect(a).not.toContain("203.0.113.7")
    expect(a).toMatch(/^rl:ip:[0-9a-f]{8}$/)
  })

  it("fnv1aHex 稳定且为 8 位 hex", () => {
    expect(fnv1aHex("abc")).toBe(fnv1aHex("abc"))
    expect(fnv1aHex("abc")).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1aHex("abc")).not.toBe(fnv1aHex("abd"))
  })

  it("accountKey 前缀正确（account_id 是 randomUUID，非 PII）", () => {
    expect(accountKey("acc-1")).toBe("rl:acct:acc-1")
  })

  it("windowIndexFor / windowedKey 按窗口切片", () => {
    expect(windowIndexFor(T0, 60)).toBe(Math.floor(T0 / 60000))
    expect(windowIndexFor(T0 + 60_000, 60)).toBe(windowIndexFor(T0, 60) + 1)
    expect(windowIndexFor(T0, 0)).toBe(-1)
    expect(windowedKey("rl:ip:deadbeef", 60, T0)).toBe(`rl:ip:deadbeef:${windowIndexFor(T0, 60)}`)
  })
})

describe("checkRateLimit（固定窗口）", () => {
  it("窗口内计数：limit=3 → 前 3 次放行，第 4 次拒绝并给 retryAfter", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    const r1 = await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    const r2 = await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    const r3 = await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true])
    expect([r1.remaining, r2.remaining, r3.remaining]).toEqual([2, 1, 0])
    expect([r1.count, r3.count]).toEqual([1, 3])
    expect([r1.degraded, r3.degraded]).toEqual([false, false])

    const r4 = await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    expect(r4.allowed).toBe(false)
    expect(r4.remaining).toBe(0)
    expect(r4.retryAfterSec).toBe(60)
    expect(r4.count).toBe(3)
  })

  it("窗口过期（下一个窗口）→ 重新放行，计数归零", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    for (let i = 0; i < 3; i++) await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    expect((await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)).allowed).toBe(false)

    nowRef.now = T0 + 60_000 // 进入下一窗口
    const next = await checkRateLimit(store, "rl:ip:x", 3, 60, nowRef.now)
    expect(next.allowed).toBe(true)
    expect(next.count).toBe(1)
    expect(next.remaining).toBe(2)
  })

  it("窗口末尾 retryAfter 按剩余时间向上取整（最小 1s）", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    for (let i = 0; i < 2; i++) await checkRateLimit(store, "rl:ip:x", 2, 60, nowRef.now)
    const denied = await checkRateLimit(store, "rl:ip:x", 2, 60, nowRef.now + 59_500)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBe(1)
  })

  it("KV TTL 取 max(60, 2×窗口)，避免跨窗边界丢计数", async () => {
    const nowRef = { now: T0 }
    const { store, map } = makeStore(nowRef)
    await checkRateLimit(store, "rl:ip:x", 5, 60, nowRef.now)
    expect(map.get(windowedKey("rl:ip:x", 60, T0))!.exp).toBe(T0 + 120_000)

    // 小窗口也不低于 KV 下限 60s
    await checkRateLimit(store, "rl:ip:y", 5, 10, nowRef.now)
    expect(map.get(windowedKey("rl:ip:y", 10, T0))!.exp).toBe(T0 + 60_000)
  })

  it("KV 缺失 → fail-open 放行 + degraded 标记", async () => {
    for (const s of [undefined, null]) {
      const r = await checkRateLimit(s, "rl:ip:x", 3, 60, T0)
      expect(r.allowed).toBe(true)
      expect(r.degraded).toBe(true)
      expect(r.remaining).toBe(3)
      expect(r.retryAfterSec).toBe(0)
    }
  })

  it("KV 读异常 → fail-open 放行 + degraded", async () => {
    const store: RateLimitStore = {
      get: async () => {
        throw new Error("kv-down")
      },
      put: async () => undefined,
    }
    const r = await checkRateLimit(store, "rl:ip:x", 3, 60, T0)
    expect(r.allowed).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.count).toBe(0)
  })

  it("KV 写异常 → 本次仍放行 + degraded（计数不可信）", async () => {
    const store: RateLimitStore = {
      get: async () => null,
      put: async () => {
        throw new Error("kv-write-fail")
      },
    }
    const r = await checkRateLimit(store, "rl:ip:x", 3, 60, T0)
    expect(r.allowed).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.count).toBe(1)
  })

  it("计数载荷损坏 → 视为 0，不抛错", async () => {
    const store: RateLimitStore = {
      get: async () => "{not-json",
      put: async () => undefined,
    }
    const r = await checkRateLimit(store, "rl:ip:x", 3, 60, T0)
    expect(r.allowed).toBe(true)
    expect(r.count).toBe(1)
  })

  it("limit <= 0 视为禁止（熔断兜底），不算 degraded", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    const r = await checkRateLimit(store, "rl:ip:x", 0, 60, nowRef.now)
    expect(r.allowed).toBe(false)
    expect(r.degraded).toBe(false)
    expect(r.retryAfterSec).toBe(60)
  })

  it("windowSec 非法 → fail-open + degraded", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    for (const w of [0, -5, Number.NaN]) {
      const r = await checkRateLimit(store, "rl:ip:x", 3, w, nowRef.now)
      expect(r.allowed).toBe(true)
      expect(r.degraded).toBe(true)
    }
  })

  it("kvRateLimitStore 适配 KVNamespace（透传 get/put + TTL）", async () => {
    const puts: Array<{ key: string; value: string; ttl?: number }> = []
    const kv = {
      get: async () => "{\"c\":1,\"t\":0}",
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        puts.push({ key, value, ttl: options?.expirationTtl })
      },
    } as unknown as KVNamespace
    const adapted = kvRateLimitStore(kv)
    expect(await adapted.get("k")).toBe("{\"c\":1,\"t\":0}")
    await adapted.put("k", "v", { expirationTtl: 120 })
    expect(puts).toEqual([{ key: "k", value: "v", ttl: 120 }])
  })
})

describe("checkSubjectRateLimit（未登录按 IP，登录按账号 + IP 兜底）", () => {
  const policy = {
    account: { limit: 2, windowSec: 60 },
    ip: { limit: 3, windowSec: 60 },
  }

  it("既无 IP 也无账号 → 放行 + degraded + scope=none（无法计数）", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    const r = await checkSubjectRateLimit(store, {}, policy, nowRef.now)
    expect(r).toEqual({ allowed: true, remaining: 0, retryAfterSec: 0, degraded: true, count: 0, scope: "none" })
  })

  it("未登录（只有 IP）→ 按 IP 计数，超限拒绝 scope=ip", async () => {
    const nowRef = { now: T0 }
    const { store, map } = makeStore(nowRef)
    const subject = { ip: "203.0.113.7" }
    for (let i = 0; i < 3; i++) {
      expect((await checkSubjectRateLimit(store, subject, policy, nowRef.now)).allowed).toBe(true)
    }
    const denied = await checkSubjectRateLimit(store, subject, policy, nowRef.now)
    expect(denied.allowed).toBe(false)
    expect(denied.scope).toBe("ip")
    // 只动 IP 桶，不创建账号桶
    expect([...map.keys()].every((k) => k.startsWith("rl:ip:"))).toBe(true)
  })

  it("登录账号：账号维度先判，超限 scope=account", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    const subject = { ip: "203.0.113.7", accountId: "acc-1" }
    expect((await checkSubjectRateLimit(store, subject, policy, nowRef.now)).allowed).toBe(true)
    expect((await checkSubjectRateLimit(store, subject, policy, nowRef.now)).allowed).toBe(true)
    const denied = await checkSubjectRateLimit(store, subject, policy, nowRef.now)
    expect(denied.allowed).toBe(false)
    expect(denied.scope).toBe("account")
  })

  it("IP 兜底：账号额度还够，但同 IP 刷满 → scope=ip", async () => {
    const nowRef = { now: T0 }
    const { store, map } = makeStore(nowRef)
    const wide = { account: { limit: 100, windowSec: 60 }, ip: { limit: 2, windowSec: 60 } }
    // 三个不同账号共用同一 IP
    expect((await checkSubjectRateLimit(store, { ip: "203.0.113.7", accountId: "acc-1" }, wide, nowRef.now)).allowed).toBe(true)
    expect((await checkSubjectRateLimit(store, { ip: "203.0.113.7", accountId: "acc-2" }, wide, nowRef.now)).allowed).toBe(true)
    const denied = await checkSubjectRateLimit(store, { ip: "203.0.113.7", accountId: "acc-3" }, wide, nowRef.now)
    expect(denied.allowed).toBe(false)
    expect(denied.scope).toBe("ip")
    expect([...map.keys()].some((k) => k.startsWith("rl:acct:acc-3"))).toBe(true)
  })

  it("两个维度都过 → remaining 取较小值，degraded 取或", async () => {
    const nowRef = { now: T0 }
    const { store } = makeStore(nowRef)
    const r = await checkSubjectRateLimit(store, { ip: "203.0.113.7", accountId: "acc-1" }, policy, nowRef.now)
    expect(r.allowed).toBe(true)
    expect(r.scope).toBe("account")
    expect(r.remaining).toBe(1) // min(account 2-1, ip 3-1)
    expect(r.degraded).toBe(false)
  })

  it("KV 缺失 → 放行 + degraded（可用性优先）", async () => {
    const r = await checkSubjectRateLimit(undefined, { ip: "203.0.113.7", accountId: "acc-1" }, policy, T0)
    expect(r.allowed).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.scope).toBe("account")
  })

  it("默认策略存在且合理（账号 ≤ IP 兜底）", () => {
    expect(DEFAULT_RATE_LIMIT_POLICY.account.limit).toBeGreaterThan(0)
    expect(DEFAULT_RATE_LIMIT_POLICY.ip.limit).toBeGreaterThanOrEqual(DEFAULT_RATE_LIMIT_POLICY.account.limit)
    expect(DEFAULT_RATE_LIMIT_POLICY.account.windowSec).toBe(60)
  })
})

describe("HTTP 辅助", () => {
  it("clientIpFromHeaders：CF-Connecting-IP 优先，其次 X-Forwarded-For 首个", () => {
    expect(clientIpFromHeaders(new Headers({ "CF-Connecting-IP": "203.0.113.7" }))).toBe("203.0.113.7")
    expect(
      clientIpFromHeaders(new Headers({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9")
    expect(
      clientIpFromHeaders(new Headers({ "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.9" })),
    ).toBe("203.0.113.7")
    expect(clientIpFromHeaders(new Headers())).toBeUndefined()
  })

  it("rateLimitHeaders 给出 Retry-After（degraded 时额外标记）", () => {
    expect(rateLimitHeaders({ allowed: false, remaining: 0, retryAfterSec: 42, degraded: false, count: 3 })).toEqual({
      "Retry-After": "42",
    })
    expect(rateLimitHeaders({ allowed: true, remaining: 1, retryAfterSec: 0, degraded: true, count: 1 })).toEqual({
      "Retry-After": "0",
      "X-RateLimit-Degraded": "1",
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 客户端 IP 信任链（Pages Function 反代场景，线上 P0 修复）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：经 Pages Function 反代时，CF 会给子请求**重新注入**内部地址当 cf-connecting-ip
// （实测 `2a06:98c0:3600::103`，且在 Pages 里删不掉），因此信任锚点是代理签发的
// `x-prism-proxy`（共享密钥）+ `x-prism-client-ip`（真实 IP），而不是任何 CF 头。
describe("clientIpFromHeaders 信任链（x-prism-proxy 共享密钥）", () => {
  /** 线上实测的那个 CF 内部地址（反代后 cf-connecting-ip 的真实值）。 */
  const INTERNAL = "2a06:98c0:3600::103"
  const SECRET = "test-proxy-secret-0123456789"

  it("未配置 PROXY_SHARED_SECRET → 带 x-prism-client-ip 也**绝不采信**（防伪造回归）", () => {
    const headers = new Headers({
      "cf-connecting-ip": INTERNAL,
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": SECRET, // 连"猜中密钥"都不该被理睬
    })
    // env 缺失 / 空密钥：都应退化为老逻辑
    for (const env of [undefined, {}, { PROXY_SHARED_SECRET: "" }]) {
      expect(clientIpFromHeaders(headers, env)).toBe(INTERNAL)
      expect(resolveClientIp(headers, env)).toEqual({ ip: INTERNAL, by: "cf-connecting-ip" })
    }
  })

  it("密钥匹配 → 采信 x-prism-client-ip（而不是 CF 内部地址）", () => {
    const headers = new Headers({
      "cf-connecting-ip": INTERNAL,
      "x-forwarded-for": "203.0.113.7",
      "x-prism-proxy": SECRET,
      "x-prism-client-ip": "203.0.113.7",
    })
    expect(clientIpFromHeaders(headers, { PROXY_SHARED_SECRET: SECRET })).toBe("203.0.113.7")
    expect(resolveClientIp(headers, { PROXY_SHARED_SECRET: SECRET })).toEqual({
      ip: "203.0.113.7",
      by: "proxy-trusted",
    })
  })

  it("密钥匹配但 x-prism-client-ip 缺失 → 回落 X-Forwarded-For 首段", () => {
    const headers = new Headers({
      "cf-connecting-ip": INTERNAL,
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      "x-prism-proxy": SECRET,
    })
    expect(clientIpFromHeaders(headers, { PROXY_SHARED_SECRET: SECRET })).toBe("203.0.113.9")
    expect(resolveClientIp(headers, { PROXY_SHARED_SECRET: SECRET })).toEqual({
      ip: "203.0.113.9",
      by: "proxy-trusted",
    })
  })

  it("x-prism-client-ip 为空/纯空白 → 视作缺失（回落 XFF，不采信空值）", () => {
    for (const empty of ["", "   "]) {
      const headers = new Headers({
        "cf-connecting-ip": INTERNAL,
        "x-forwarded-for": "203.0.113.9",
        "x-prism-proxy": SECRET,
        "x-prism-client-ip": empty,
      })
      expect(clientIpFromHeaders(headers, { PROXY_SHARED_SECRET: SECRET })).toBe("203.0.113.9")
    }
  })

  it("密钥不匹配（错值 / 空值 / 只有头没配密钥）→ 一律不采信", () => {
    const ipHeaders = { "cf-connecting-ip": INTERNAL, "x-prism-client-ip": "1.2.3.4" }
    const cases: Array<[string, string | undefined]> = [
      [SECRET.slice(0, -1) + "X", SECRET], // 等长错值
      ["wrong", SECRET], // 长度不同
      ["", SECRET], // 空值头
      ["   ", SECRET], // 纯空白头（Headers 会 trim 成空串 → 仍不等）
      [SECRET, `${SECRET} `], // 配置值多了个尾空格（Headers 会 trim 头值，所以这是真的不相等）
      [SECRET, SECRET + "-extra"], // 值对但配置的是另一个（更长）密钥
      [SECRET, ""], // 有头没配密钥
      [SECRET, undefined], // 有头、env 里根本没这个字段
    ]
    for (const [headerValue, secret] of cases) {
      const headers = new Headers({ ...ipHeaders, "x-prism-proxy": headerValue })
      const env = secret === undefined ? {} : { PROXY_SHARED_SECRET: secret }
      expect(resolveClientIp(headers, env)).toEqual({ ip: INTERNAL, by: "cf-connecting-ip" })
    }
  })

  it("直连场景（无 x-prism-*）→ 与今天完全一致：cf-connecting-ip 优先", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" })
    // 配了密钥也一样（没带凭据头 = 不是我们的代理）
    for (const env of [undefined, {}, { PROXY_SHARED_SECRET: SECRET }]) {
      expect(resolveClientIp(headers, env)).toEqual({ ip: "203.0.113.7", by: "cf-connecting-ip" })
    }
  })

  it("伪造场景：自带 X-Forwarded-For: 1.2.3.4 且无代理凭据 → 仍以 cf-connecting-ip 为准", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
    })
    for (const env of [undefined, { PROXY_SHARED_SECRET: SECRET }]) {
      expect(resolveClientIp(headers, env)).toEqual({ ip: "203.0.113.7", by: "cf-connecting-ip" })
    }
  })

  it("伪造场景：自带 XFF + 伪造的 x-prism-proxy → 密钥不对，仍以 cf-connecting-ip 为准", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": "guess",
    })
    expect(resolveClientIp(headers, { PROXY_SHARED_SECRET: SECRET })).toEqual({
      ip: "203.0.113.7",
      by: "cf-connecting-ip",
    })
  })

  it("代理已验签但两个声明头都缺失 → 回落老逻辑（不返回空，避免限流直接失效）", () => {
    const headers = new Headers({ "cf-connecting-ip": INTERNAL, "x-prism-proxy": SECRET })
    expect(resolveClientIp(headers, { PROXY_SHARED_SECRET: SECRET })).toEqual({
      ip: INTERNAL,
      by: "cf-connecting-ip",
    })
  })

  it("老逻辑的 XFF 分支与 none 分支保持原样", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9")
    expect(resolveClientIp(new Headers())).toEqual({ by: "none" })
    expect(clientIpFromHeaders(new Headers())).toBeUndefined()
  })

  it("头名常量与 Pages Function 的写入端对齐（防两端改名漂移）", () => {
    expect(PROXY_SECRET_HEADER).toBe("x-prism-proxy")
    expect(PROXY_CLIENT_IP_HEADER).toBe("x-prism-client-ip")
    // Headers 大小写不敏感：大小写写法不同也必须能取到
    expect(
      clientIpFromHeaders(new Headers({ "X-Prism-Proxy": SECRET, "X-Prism-Client-IP": "203.0.113.7" }), {
        PROXY_SHARED_SECRET: SECRET,
      }),
    ).toBe("203.0.113.7")
  })

  it("采信到的 IP 会进入限流桶（代理路径下不同用户不同桶）", async () => {
    const nowRef = { now: T0 }
    const { store, map } = makeStore(nowRef)
    const env = { PROXY_SHARED_SECRET: SECRET }
    const make = (ip: string): Headers =>
      new Headers({ "cf-connecting-ip": INTERNAL, "x-prism-proxy": SECRET, "x-prism-client-ip": ip })
    const a = clientIpFromHeaders(make("203.0.113.7"), env)!
    const b = clientIpFromHeaders(make("203.0.113.8"), env)!
    await checkSubjectRateLimit(store, { ip: a }, { account: { limit: 5, windowSec: 60 }, ip: { limit: 1, windowSec: 60 } }, nowRef.now)
    // 另一个 IP 不该被前一个用户刷掉（老逻辑下两者都会被归到 CF 内部地址这一个桶）
    const other = await checkSubjectRateLimit(store, { ip: b }, { account: { limit: 5, windowSec: 60 }, ip: { limit: 1, windowSec: 60 } }, nowRef.now)
    expect(other.allowed).toBe(true)
    expect([...map.keys()].filter((k) => k.startsWith("rl:ip:")).length).toBe(2)
    expect([...map.keys()].some((k) => k.includes(fnv1aHex(INTERNAL)))).toBe(false)
  })
})

describe("timingSafeEqualString（恒时比较边界）", () => {
  it("相等 → true；等长不同值 / 前缀相同但末位不同 → false", () => {
    expect(timingSafeEqualString("secret-aaaa", "secret-aaaa")).toBe(true)
    expect(timingSafeEqualString("secret-aaaa", "secret-aaab")).toBe(false) // 末位不同
    expect(timingSafeEqualString("abcdef", "abcdeg")).toBe(false)
    expect(timingSafeEqualString("", "")).toBe(true)
  })

  it("长度不同 → 直接 false（不抛越界错）", () => {
    expect(timingSafeEqualString("abc", "abcd")).toBe(false)
    expect(timingSafeEqualString("abcd", "abc")).toBe(false)
    expect(timingSafeEqualString("", "a")).toBe(false)
    expect(timingSafeEqualString("a", "")).toBe(false)
  })

  it("非 ASCII / 超长密钥也稳定判等", () => {
    expect(timingSafeEqualString("密钥🔑", "密钥🔑")).toBe(true)
    expect(timingSafeEqualString("密钥🔑", "密钥🔒")).toBe(false)
    const long = "x".repeat(4096)
    expect(timingSafeEqualString(long, long)).toBe(true)
    expect(timingSafeEqualString(long, `${"x".repeat(4095)}y`)).toBe(false)
  })
})
