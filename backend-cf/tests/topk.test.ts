// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 返回条数策略与成本模型（plan-topk.md §0 决策表 / §3.1 / §3.2 / §3.3）
// 纯函数、零 IO、零网络：候选数公式、匿名夹取、rerank 成本核对表**逐条断言**。
import { describe, it, expect } from "vitest"
import {
  ANON_TOP_K_MAX,
  ANON_TOP_K_WARNING,
  DEFAULT_RERANK_MAX_CANDIDATES,
  DEFAULT_RERANK_OVERFETCH,
  TOP_K_DEFAULT,
  TOP_K_MAX,
  TOP_K_MIN,
  clampTopKForAnon,
  rerankCandidateLimit,
  rerankMaxCandidates,
  rerankOverfetch,
} from "../src/topk"
import { QUOTA_COST, QUOTA_RERANK_BASE_CANDIDATES, computeQuotaCost, rerankCostTokens } from "../src/quota"

describe("常量（与 plan-topk.md §0/§3.1 对齐）", () => {
  it("范围 1–50、默认 10、匿名上限 5、warning 标记", () => {
    expect(TOP_K_MIN).toBe(1)
    expect(TOP_K_MAX).toBe(50)
    expect(TOP_K_DEFAULT).toBe(10)
    expect(ANON_TOP_K_MAX).toBe(5)
    expect(ANON_TOP_K_WARNING).toBe("top-k-clamped-anon")
  })

  it("过采样默认 3×、候选上限 64（= 2 × rerank 每批 32）", () => {
    expect(DEFAULT_RERANK_OVERFETCH).toBe(3)
    expect(DEFAULT_RERANK_MAX_CANDIDATES).toBe(64)
    expect(DEFAULT_RERANK_MAX_CANDIDATES).toBe(2 * 32) // 每批 32 条 HTTP → 恰好两批
  })
})

describe("rerankCandidateLimit：候选数（默认 3× / 封顶 64）", () => {
  it("plan-topk.md 的举例逐条成立：1→3；5→15；10→30；20→60；n≥22→64", () => {
    expect(rerankCandidateLimit({}, 1)).toBe(3)
    expect(rerankCandidateLimit({}, 5)).toBe(15)
    expect(rerankCandidateLimit({}, 10)).toBe(30)
    expect(rerankCandidateLimit({}, 20)).toBe(60)
    expect(rerankCandidateLimit({}, 21)).toBe(63)
    expect(rerankCandidateLimit({}, 22)).toBe(64) // ceil(66) 被 64 封顶
    expect(rerankCandidateLimit({}, 50)).toBe(64)
  })

  it("候选数永不低于 n（否则用户拿不满请求的条数）、永不高于上限", () => {
    for (let n = TOP_K_MIN; n <= TOP_K_MAX; n++) {
      const c = rerankCandidateLimit({}, n)
      expect(c, `n=${n}`).toBeGreaterThanOrEqual(n)
      expect(c, `n=${n}`).toBeLessThanOrEqual(DEFAULT_RERANK_MAX_CANDIDATES)
    }
  })

  it("env 覆盖：RERANK_OVERFETCH / RERANK_MAX_CANDIDATES 生效（含非法值回默认）", () => {
    expect(rerankCandidateLimit({ RERANK_OVERFETCH: "2" }, 10)).toBe(20)
    expect(rerankCandidateLimit({ RERANK_OVERFETCH: "5" }, 10)).toBe(50)
    expect(rerankCandidateLimit({ RERANK_MAX_CANDIDATES: "30" }, 10)).toBe(30)
    expect(rerankCandidateLimit({ RERANK_MAX_CANDIDATES: "30" }, 50)).toBe(50) // 下界 n 优先于上限
    expect(rerankCandidateLimit({ RERANK_OVERFETCH: "0" }, 10)).toBe(30) // 非法 → 默认 3×
    expect(rerankCandidateLimit({ RERANK_OVERFETCH: "abc" }, 10)).toBe(30)
    expect(rerankCandidateLimit({ RERANK_MAX_CANDIDATES: "-1" }, 10)).toBe(30)
    expect(rerankOverfetch({ RERANK_OVERFETCH: "4" })).toBe(4)
    expect(rerankOverfetch({})).toBe(3)
    expect(rerankMaxCandidates({ RERANK_MAX_CANDIDATES: "128" })).toBe(128)
    expect(rerankMaxCandidates({})).toBe(64)
  })

  it("RERANK_TOP_K 是**最高优先级的显式绝对覆盖**（向后兼容：不乘系数、不受上限约束）", () => {
    expect(rerankCandidateLimit({ RERANK_TOP_K: "40" }, 10)).toBe(40) // 3× 会给 30，这里按 40
    expect(rerankCandidateLimit({ RERANK_TOP_K: "200" }, 10)).toBe(200) // 显式覆盖优先于 MAX_CANDIDATES
    expect(rerankCandidateLimit({ RERANK_TOP_K: "40", RERANK_MAX_CANDIDATES: "20" }, 10)).toBe(40)
    expect(rerankCandidateLimit({ RERANK_TOP_K: "" }, 10)).toBe(30) // 空串 = 没配
    expect(rerankCandidateLimit({ RERANK_TOP_K: "abc" }, 10)).toBe(30) // 非法 = 没配
  })
})

describe("clampTopKForAnon：未登录夹取（不报错）", () => {
  it("未登录：>5 夹到 5 并标记 clamped；<=5 不动", () => {
    expect(clampTopKForAnon(50, false)).toEqual({ topK: 5, clamped: true })
    expect(clampTopKForAnon(6, false)).toEqual({ topK: 5, clamped: true })
    expect(clampTopKForAnon(5, false)).toEqual({ topK: 5, clamped: false })
    expect(clampTopKForAnon(1, false)).toEqual({ topK: 1, clamped: false })
    // 不传 top_k → 走默认 10 → 对未登录而言仍然 >5 → 同样夹到 5（并给 warning，客户端据此得知匿名上限）
    expect(clampTopKForAnon(undefined, false)).toEqual({ topK: 5, clamped: true })
  })

  it("登录用户不受限：50 原样通过", () => {
    expect(clampTopKForAnon(50, true)).toEqual({ topK: 50, clamped: false })
    expect(clampTopKForAnon(undefined, true)).toEqual({ topK: TOP_K_DEFAULT, clamped: false })
  })
})

describe("成本模型：plan-topk.md §3.3 核对表（逐条断言，值由代码算出）", () => {
  const table = [
    { n: 1, candidates: 3, rerank: 20, total: 220 },
    { n: 5, candidates: 15, rerank: 100, total: 300 },
    { n: 10, candidates: 30, rerank: 200, total: 400 },
    { n: 20, candidates: 60, rerank: 400, total: 600 },
    { n: 50, candidates: 64, rerank: 427, total: 627 },
  ]

  for (const row of table) {
    it(`n=${row.n} → 候选 ${row.candidates}、rerank ${row.rerank}、总 ${row.total}`, () => {
      expect(rerankCandidateLimit({}, row.n)).toBe(row.candidates)
      expect(rerankCostTokens({}, row.n)).toBe(row.rerank)
      expect(computeQuotaCost({ search: true, rerank: true, topK: row.n })).toBe(row.total)
      // 纯检索：**任何 n 都是 200**（§0 决策 1：embed 1 次、Qdrant 1 次，与 n 无关）
      expect(computeQuotaCost({ search: true, topK: row.n })).toBe(200)
    })
  }

  it("归一化基准：候选 30 条 = 200 token（= 1 个纯搜索）→ 默认 n=10 恰为 2×", () => {
    expect(QUOTA_RERANK_BASE_CANDIDATES).toBe(30)
    expect(QUOTA_COST.search).toBe(200)
    expect(computeQuotaCost({ rerank: true, topK: 10 })).toBe(2 * QUOTA_COST.search)
  })

  it("纯搜索在任何 n（1…50）下都恒为 200；默认 topK=10 与不传 topK 等价", () => {
    for (let n = TOP_K_MIN; n <= TOP_K_MAX; n++) expect(computeQuotaCost({ search: true, topK: n }), `n=${n}`).toBe(200)
    expect(computeQuotaCost({ rerank: true })).toBe(computeQuotaCost({ rerank: true, topK: 10 }))
  })

  it("env 覆盖后成本与候选数**同步**变化（不会出现「按 30 条收费、实际打 64 条」）", () => {
    const env = { RERANK_MAX_CANDIDATES: "30", RERANK_OVERFETCH: "3" }
    expect(rerankCandidateLimit(env, 50)).toBe(50) // 下界 n
    expect(rerankCostTokens(env, 50)).toBe(Math.ceil((200 * 50) / 30)) // 334
    expect(computeQuotaCost({ rerank: true, topK: 50 }, env)).toBe(200 + 334)
    // 与真实检索共用同一个函数：候选数变了，成本跟着变
    const env2 = { RERANK_MAX_CANDIDATES: "10" }
    expect(rerankCandidateLimit(env2, 5)).toBe(10)
    expect(rerankCostTokens(env2, 5)).toBe(Math.ceil((200 * 10) / 30)) // 67
  })

  it("LLM token 仍按真实用量、不受 n 影响；回退恒 0；QUOTA_COST.rerank 已废弃不再参与计算", () => {
    expect(computeQuotaCost({ llmTokens: 900, topK: 50 })).toBe(200 + 900)
    expect(computeQuotaCost({ fallback: true, rerank: true, topK: 50 })).toBe(0)
    // 废弃常量仍保留（兼容引用），但改成任何值都不影响成本
    expect(computeQuotaCost({ rerank: true, topK: 10 })).toBe(400) // 不是 200+100
  })
})
