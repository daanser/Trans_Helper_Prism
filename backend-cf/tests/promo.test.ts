// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 开业酬宾（限时 DeepSeek V4.1 Flash）单测（plan-promo.md §5.1/§5.6）
//
// 覆盖（全 mock，零网络）：
//   ① 独立密钥池：`DS_POOL_KEY_<n>` → ref `ds-pool-key-<n>`，**绝不与 POOL_KEYS_<n> 混**；
//   ② 成本自算口径（¥2/M miss、¥0.04/M 命中、¥8/M 输出；思考计入输出）；
//   ③ 状态判定五条闸：env 关 / 没 key / KV flag 关 / 过期 / 预算尽（含 5% 余量）；
//   ④ 预算累计（KV 读改写）、关闭促销、D1 对账（只往上修正）；
//   ⑤ `promoDaysLeft`（烧钱速度 → 还能撑几天）。
import { describe, it, expect, beforeEach } from "vitest"
import {
  PROMO_BUDGET_CNY_DEFAULT,
  PROMO_DAYS_DEFAULT,
  PROMO_DENY_KV_KEY,
  PROMO_KV_KEY,
  PROMO_QUOTA_WINDOW_TOKENS_DEFAULT,
  addPromoSpendCny,
  closePromo,
  formatCny,
  parsePromoFlag,
  promoBudgetGuardCny,
  promoCostCny,
  promoDaysLeft,
  promoDeniedRefs,
  promoKeyVarOptions,
  promoKeys,
  readPromoState,
  reconcileSpentCny,
  resetPromoCache,
  resolvePromoState,
  setPromoKeyDenied,
  type PromoKvStore,
} from "../src/promo"
import { parseMergedKeys } from "../src/keypool"
import { poolKeysEnv } from "./poolKeysEnv"

/** 内存 KV（可注入读/写失败）。 */
function makeKv(seed: Record<string, string> = {}, opts: { failGet?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const kv: PromoKvStore = {
    async get(key) {
      if (opts.failGet) throw new Error("kv-get-failed")
      return store.get(key) ?? null
    },
    async put(key, value) {
      if (opts.failPut) throw new Error("kv-put-failed")
      writes.push(key)
      store.set(key, value)
    },
  }
  return { kv, store, writes }
}

const DS_KEYS = { DS_POOL_KEY_0: "ds-secret-a", DS_POOL_KEY_1: "ds-secret-b" }

beforeEach(() => resetPromoCache())

describe("① 独立密钥池（绝不与 POOL_KEYS_<n> 混）", () => {
  it("DS_POOL_KEY_<n> → ref ds-pool-key-<n>；与合并池互不可见", () => {
    const keys = promoKeys(DS_KEYS)
    expect(keys.map((k) => k.ref)).toEqual(["ds-pool-key-0", "ds-pool-key-1"])
    expect(keys.map((k) => k.secret)).toEqual(["ds-secret-a", "ds-secret-b"])
    // 合并池解析不到 DS 变量；促销池解析不到 POOL_KEYS_<n>（混池必然 401，plan §5.1）
    expect(parseMergedKeys(DS_KEYS)).toEqual([])
    expect(promoKeys(poolKeysEnv(["sk-a", "sk-b"]))).toEqual([])
    expect(promoKeyVarOptions()).toEqual({ varPrefix: "DS_POOL_KEY_", refPrefix: "ds-pool" })
  })

  it("缺 key / 空值 → 空池（状态判定会给出 no-keys，不会去调上游）", () => {
    expect(promoKeys({})).toEqual([])
    expect(promoKeys({ DS_POOL_KEY_0: "  " })).toEqual([])
    expect(promoKeys(null)).toEqual([])
  })
})

describe("② 成本自算（主口径；上游 cost_cny 未结算时为 0，只能对账）", () => {
  it("按 A1 单价：miss ¥2/M、命中 ¥0.04/M、输出 ¥8/M", () => {
    // 实测样例（plan §3）：9 输入 + 41 输出、无缓存 → ¥0.000346
    expect(promoCostCny({ promptTokens: 9, completionTokens: 41 })).toBeCloseTo(0.000346, 9)
    // 全命中输入：1M 输入全命中 + 0 输出 = ¥0.04
    expect(promoCostCny({ promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(0.04, 9)
    // 全未命中输入：1M = ¥2
    expect(promoCostCny({ promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(2, 9)
    // 输出 1M = ¥8（思考 token 计入 completion_tokens，已覆盖）
    expect(promoCostCny({ promptTokens: 0, completionTokens: 1_000_000 })).toBeCloseTo(8, 9)
    // 混合：0.5M 未命中 + 0.5M 命中 + 0.1M 输出 = 1 + 0.02 + 0.8
    expect(
      promoCostCny({ promptTokens: 1_000_000, cachedTokens: 500_000, completionTokens: 100_000 }),
    ).toBeCloseTo(1.82, 9)
  })

  it("脏值/缺字段：按 0 处理；cached > prompt 时夹到 prompt（绝不出现负的 miss）", () => {
    expect(promoCostCny({ promptTokens: Number.NaN, completionTokens: -5 })).toBe(0)
    expect(promoCostCny({ promptTokens: 100, cachedTokens: 999, completionTokens: 0 })).toBeCloseTo((100 / 1e6) * 0.04, 9)
  })

  it("formatCny 固定 6 位（¥0.000001 级别也看得见）", () => {
    expect(formatCny(0.000346)).toBe("0.000346")
    expect(formatCny(Number.NaN)).toBe("0.000000")
  })
})

describe("③ 状态判定五条闸（resolvePromoState）", () => {
  const base = { nowMs: 1_800_000_000_000, keyCount: 2, degraded: false }

  it("正常开启：模型/端点/预算/额度窗口都取默认（端点尾部斜杠会被去掉）", () => {
    const st = resolvePromoState({ env: { ...DS_KEYS, DS_ENDPOINT: "https://tokenrhythm.studio/v1/" }, flag: null, ...base })
    expect(st.enabled).toBe(true)
    expect(st.reason).toBe("enabled")
    expect(st.model).toBe("deepseek-flash")
    expect(st.endpoint).toBe("https://tokenrhythm.studio/v1")
    expect(st.budgetCny).toBe(PROMO_BUDGET_CNY_DEFAULT)
    expect(st.quotaWindowTokens).toBe(PROMO_QUOTA_WINDOW_TOKENS_DEFAULT)
    expect(st.maxTokens).toBe(4000)
  })

  it("闸 1：env PROMO_ENABLED=false → disabled-by-env", () => {
    const st = resolvePromoState({ env: { ...DS_KEYS, PROMO_ENABLED: "false" }, flag: null, ...base })
    expect(st.enabled).toBe(false)
    expect(st.reason).toBe("disabled-by-env")
  })

  it("闸 2：没配任何 DS key → no-keys（即使 env 开着也不去调上游）", () => {
    const st = resolvePromoState({ env: {}, flag: null, ...base, keyCount: 0 })
    expect(st.enabled).toBe(false)
    expect(st.reason).toBe("no-keys")
  })

  it("闸 3：KV flag enabled=false（管理员/上游欠费收闸）→ disabled-by-flag", () => {
    const st = resolvePromoState({ env: DS_KEYS, flag: { enabled: false }, ...base })
    expect(st.enabled).toBe(false)
    expect(st.reason).toBe("disabled-by-flag")
  })

  it("闸 4：过期（ends_at 已过）→ expired；未到则仍然开", () => {
    const flag = { ends_at: base.nowMs - 1 }
    expect(resolvePromoState({ env: DS_KEYS, flag, ...base })).toMatchObject({ enabled: false, reason: "expired" })
    expect(resolvePromoState({ env: DS_KEYS, flag: { ends_at: base.nowMs + 1 }, ...base }).enabled).toBe(true)
  })

  it("闸 5：预算尽（含 5% 余量）→ budget-exhausted；剩余金额不出现负数", () => {
    const guard = promoBudgetGuardCny(PROMO_BUDGET_CNY_DEFAULT)
    expect(guard).toBeCloseTo(129.2, 6)
    expect(resolvePromoState({ env: DS_KEYS, flag: { spent_cny: guard - 0.01 }, ...base }).enabled).toBe(true)
    const over = resolvePromoState({ env: DS_KEYS, flag: { spent_cny: guard }, ...base })
    expect(over).toMatchObject({ enabled: false, reason: "budget-exhausted" })
    // 剩余金额按**预算**算（那 5% 是被刻意留出的安全余量，不花掉；收闸只是不再发起新请求）
    expect(over.remainingCny).toBeCloseTo(PROMO_BUDGET_CNY_DEFAULT - guard, 6)
    // 真花超预算时不会出现负数
    expect(resolvePromoState({ env: DS_KEYS, flag: { spent_cny: 999 }, ...base }).remainingCny).toBe(0)
  })

  it("期限优先级：env PROMO_END_AT > KV ends_at > started_at + PROMO_DAYS（默认 30 天）", () => {
    const startedAt = base.nowMs - 1000
    const st = resolvePromoState({ env: DS_KEYS, flag: { started_at: startedAt }, ...base })
    expect(st.endsAt).toBe(startedAt + PROMO_DAYS_DEFAULT * 86_400_000)
    const st2 = resolvePromoState({ env: { ...DS_KEYS, PROMO_DAYS: "7" }, flag: { started_at: startedAt }, ...base })
    expect(st2.endsAt).toBe(startedAt + 7 * 86_400_000)
    const envEnd = base.nowMs + 12_345
    const st3 = resolvePromoState({ env: { ...DS_KEYS, PROMO_END_AT: String(envEnd) }, flag: { ends_at: 1 }, ...base })
    expect(st3.endsAt).toBe(envEnd)
  })

  it("KV 不可用（degraded）时按 env 判定（fail-open：能用就用，且如实标 degraded）", () => {
    const st = resolvePromoState({ env: DS_KEYS, flag: null, ...base, degraded: true })
    expect(st.enabled).toBe(true)
    expect(st.degraded).toBe(true)
  })

  it("parsePromoFlag：脏值/数组/字符串 → null（当作没配）", () => {
    expect(parsePromoFlag(null)).toBeNull()
    expect(parsePromoFlag("{oops")).toBeNull()
    expect(parsePromoFlag("[1,2]")).toBeNull()
    expect(parsePromoFlag('"x"')).toBeNull()
    expect(parsePromoFlag('{"enabled":false}')).toEqual({ enabled: false })
  })
})

describe("④ 状态读取 / 预算累计 / 收闸 / 对账（KV 层）", () => {
  it("首次读到会补写 started_at（让「部署 + 30 天」有起点），并把状态缓存住（TTL 内不再读 KV）", async () => {
    const { kv, store, writes } = makeKv()
    const t0 = 1_800_000_000_000
    const first = await readPromoState(kv, DS_KEYS, t0)
    expect(first.enabled).toBe(true)
    expect(writes).toContain(PROMO_KV_KEY)
    expect(JSON.parse(store.get(PROMO_KV_KEY)!).started_at).toBe(t0)
    // TTL 内不重读：把 store 清空也不影响（走缓存）
    store.clear()
    const second = await readPromoState(kv, DS_KEYS, t0 + 10_000)
    expect(second).toEqual(first)
    // TTL 过后重读
    const third = await readPromoState(kv, DS_KEYS, t0 + 31_000)
    expect(third.enabled).toBe(true)
  })

  it("KV 读失败 → 按 env 判定 + degraded=true（绝不抛错）", async () => {
    const { kv } = makeKv({}, { failGet: true })
    const st = await readPromoState(kv, DS_KEYS, 1)
    expect(st.enabled).toBe(true)
    expect(st.degraded).toBe(true)
  })

  it("KV 缺失（无绑定）→ 同样 degraded 且不抛错", async () => {
    const st = await readPromoState(undefined, DS_KEYS, 1)
    expect(st.enabled).toBe(true)
    expect(st.degraded).toBe(true)
  })

  it("累加花销：读改写合并、写失败返回 ok:false（预算护栏不阻断业务）", async () => {
    const { kv, store } = makeKv()
    const a = await addPromoSpendCny(kv, 0.5, 1)
    expect(a).toMatchObject({ ok: true })
    expect(a.spentCny).toBeCloseTo(0.5, 9)
    const b = await addPromoSpendCny(kv, 0.25, 2)
    expect(b.spentCny).toBeCloseTo(0.75, 9)
    expect(JSON.parse(store.get(PROMO_KV_KEY)!).spent_cny).toBeCloseTo(0.75, 9)
    // 非法增量不写
    expect((await addPromoSpendCny(kv, -1, 3)).ok).toBe(false)
    const { kv: bad } = makeKv({}, { failPut: true })
    expect((await addPromoSpendCny(bad, 1, 4)).ok).toBe(false)
  })

  it("累加后立刻失效缓存：下一读就能看到「钱变多了」（预算闸不会滞后 30s）", async () => {
    const { kv } = makeKv()
    const t0 = 1_800_000_000_000
    await readPromoState(kv, DS_KEYS, t0)
    await addPromoSpendCny(kv, 200, t0 + 1) // 直接超过预算
    const st = await readPromoState(kv, DS_KEYS, t0 + 2)
    expect(st.enabled).toBe(false)
    expect(st.reason).toBe("budget-exhausted")
  })

  it("closePromo：写 enabled=false + note（上游 401/欠费时调用）", async () => {
    const { kv, store } = makeKv({ [PROMO_KV_KEY]: JSON.stringify({ started_at: 1, spent_cny: 3 }) })
    expect(await closePromo(kv, "upstream-401", 9)).toBe(true)
    const flag = JSON.parse(store.get(PROMO_KV_KEY)!)
    expect(flag).toMatchObject({ enabled: false, note: "upstream-401", spent_cny: 3, started_at: 1 })
    // 关闭后读到的就是 disabled-by-flag
    resetPromoCache()
    expect((await readPromoState(kv, DS_KEYS, 10)).reason).toBe("disabled-by-flag")
    // KV 缺失 → false（fail-open，不影响业务）
    expect(await closePromo(undefined, "x", 1)).toBe(false)
  })

  it("对账：D1 真值更大时回写（KV 少算）；更小时不动（多算不回退，宁早不晚）", async () => {
    const { kv, store } = makeKv({ [PROMO_KV_KEY]: JSON.stringify({ spent_cny: 1 }) })
    const up = await reconcileSpentCny(kv, 5, 2)
    expect(up).toMatchObject({ ok: true, wrote: true })
    expect(up.spentCny).toBeCloseTo(5, 9)
    expect(JSON.parse(store.get(PROMO_KV_KEY)!).spent_cny).toBeCloseTo(5, 9)

    const down = await reconcileSpentCny(kv, 2, 3)
    expect(down).toMatchObject({ ok: true, wrote: false })
    expect(down.spentCny).toBeCloseTo(5, 9)
  })
})

describe("DS 池的禁用集（admin 下架某把促销 key；与合并池的 keydeny:keys 互不影响）", () => {
  it("setPromoKeyDenied 写 keydeny:ds；readPromoState 把它读进 promoDeniedRefs", async () => {
    const { kv, store } = makeKv()
    const off = await setPromoKeyDenied(kv, "ds-pool-key-1", false)
    expect(off.ok).toBe(true)
    expect(off.refs).toEqual(["ds-pool-key-1"])
    expect(store.get(PROMO_DENY_KV_KEY)).toBe("ds-pool-key-1")
    // 读状态时会一并读出禁用集（与促销 flag 同一次 KV 往返）
    resetPromoCache()
    await readPromoState(kv, DS_KEYS, 5)
    expect(promoDeniedRefs()).toEqual(["ds-pool-key-1"])
    // 上架 → 从集合里移除
    const on = await setPromoKeyDenied(kv, "ds-pool-key-1", true)
    expect(on.refs).toEqual([])
    expect(store.get(PROMO_DENY_KV_KEY)).toBe("")
    // KV 缺失 → ok:false（fail-open，管理动作不阻断业务）
    expect((await setPromoKeyDenied(undefined, "ds-pool-key-0", false)).ok).toBe(false)
  })
})

describe("⑤ 烧钱速度 → 还能撑几天", () => {
  it("按近 24h 速度换算；速度为 0 / 预算已尽 / 非法值分别给 null / 0 / null", () => {
    expect(promoDaysLeft(0, 136, 2)).toBe(68)
    expect(promoDaysLeft(100, 136, 2)).toBe(18)
    expect(promoDaysLeft(136, 136, 2)).toBe(0)
    expect(promoDaysLeft(0, 136, 0)).toBeNull()
    expect(promoDaysLeft(Number.NaN, 136, 1)).toBeNull()
  })
})
