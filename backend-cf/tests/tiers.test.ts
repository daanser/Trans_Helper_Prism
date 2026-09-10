// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 分档判定与限额单测（plan-ratelimit.md §4）
// 纯函数、零 IO、零网络：穷举六档判定、env 覆盖、LLM 除数的取整边界与下限。
import { describe, it, expect } from "vitest"
import { CN_IDC_ASN, CN_RESIDENTIAL_ASN, OVERSEAS_HOSTING_ASN } from "../src/data/cn-asn"
import {
  anonGlobalHardLimit,
  anonGlobalLimit,
  burstPer10s,
  BURST_BLOCK_SEC,
  BURST_WINDOW_SEC,
  decideTier,
  DEFAULT_ANON_GLOBAL_HARD_PER_MIN,
  DEFAULT_ANON_GLOBAL_PER_MIN,
  DEFAULT_BURST_PER_10S,
  DEFAULT_LLM_DIVISOR,
  isKnownHostingAsn,
  limitForTier,
  llmDivisor,
  llmLimitForTier,
  normalizeAsn,
  normalizeCountry,
  RATE_WINDOW_SEC,
  TIER_DEFAULT_LIMITS,
  TIER_LIMIT_ENV,
  TIERS,
} from "../src/tiers"

describe("默认值与常量（与 plan §4/§6 逐项对齐）", () => {
  it("六档默认限额：60 / 30 / 15 / 6 / 10 / 5", () => {
    expect(TIER_DEFAULT_LIMITS.logged_in).toBe(60)
    expect(TIER_DEFAULT_LIMITS.cn_residential).toBe(30)
    expect(TIER_DEFAULT_LIMITS.cn_other).toBe(15)
    expect(TIER_DEFAULT_LIMITS.cn_idc).toBe(6) // 刻意低于境外（plan §4）
    expect(TIER_DEFAULT_LIMITS.overseas).toBe(10)
    expect(TIER_DEFAULT_LIMITS.unknown).toBe(5)
    expect(TIERS).toEqual(["logged_in", "cn_residential", "cn_idc", "cn_other", "overseas", "unknown"])
  })

  it("env 变量名照 plan §4（逐字符，防改错名字导致线上配置失灵）", () => {
    expect(TIER_LIMIT_ENV).toEqual({
      logged_in: "RATE_LIMIT_LOGGED_IN_PER_MIN",
      cn_residential: "RATE_LIMIT_CN_RESIDENTIAL_PER_MIN",
      cn_other: "RATE_LIMIT_CN_OTHER_PER_MIN",
      cn_idc: "RATE_LIMIT_CN_IDC_PER_MIN",
      overseas: "RATE_LIMIT_OVERSEAS_PER_MIN",
      unknown: "RATE_LIMIT_UNKNOWN_PER_MIN",
    })
    expect(DEFAULT_LLM_DIVISOR).toBe(5)
    expect(DEFAULT_BURST_PER_10S).toBe(20)
    expect(DEFAULT_ANON_GLOBAL_PER_MIN).toBe(600)
    expect(DEFAULT_ANON_GLOBAL_HARD_PER_MIN).toBe(1200)
    expect(RATE_WINDOW_SEC).toBe(60)
    expect(BURST_WINDOW_SEC).toBe(10)
    expect(BURST_BLOCK_SEC).toBe(60)
  })
})

describe("归一化（国家码 / ASN）", () => {
  it("country：大小写与空白归一，非两字母一律 undefined", () => {
    expect(normalizeCountry("cn")).toBe("CN")
    expect(normalizeCountry(" Cn ")).toBe("CN")
    expect(normalizeCountry("US")).toBe("US")
    expect(normalizeCountry("")).toBeUndefined()
    expect(normalizeCountry("   ")).toBeUndefined()
    expect(normalizeCountry("CHN")).toBeUndefined() // 只认 alpha-2
    expect(normalizeCountry(undefined)).toBeUndefined()
    expect(normalizeCountry("1")).toBeUndefined()
  })

  it("asn：吃掉 AS 前缀与空白；非数字一律 undefined", () => {
    expect(normalizeAsn("4134")).toBe("4134")
    expect(normalizeAsn(" AS4134 ")).toBe("4134")
    expect(normalizeAsn("as4134")).toBe("4134")
    expect(normalizeAsn(4134)).toBe("4134")
    expect(normalizeAsn("")).toBeUndefined()
    expect(normalizeAsn("AS")).toBeUndefined()
    expect(normalizeAsn("abc")).toBeUndefined()
    expect(normalizeAsn(-1)).toBeUndefined()
    expect(normalizeAsn(undefined)).toBeUndefined()
  })
})

describe("decideTier：六档判定（plan §4 的顺序）", () => {
  it("logged_in 压过一切网络元数据（含缺元数据）", () => {
    expect(decideTier({ loggedIn: true, country: "CN", asn: "4134" })).toBe("logged_in")
    expect(decideTier({ loggedIn: true, country: "US", asn: "16509" })).toBe("logged_in")
    expect(decideTier({ loggedIn: true })).toBe("logged_in")
  })

  it("CN + 家宽/移动白名单 → cn_residential（含各省移动与教育网）", () => {
    for (const asn of ["4134", "4809", "4837", "9929", "9808", "56040", "56044", "56048", "24400", "4538"]) {
      expect(decideTier({ loggedIn: false, country: "CN", asn })).toBe("cn_residential")
    }
  })

  it("CN + 云/机房名单 → cn_idc（阿里/腾讯/华为/UCloud/百度）", () => {
    for (const asn of ["45102", "37963", "132203", "45090", "136907", "135377", "55967"]) {
      expect(decideTier({ loggedIn: false, country: "CN", asn })).toBe("cn_idc")
    }
  })

  it("CN + 既不在白名单也不在 IDC 名单 → cn_other（保守中间档）", () => {
    expect(decideTier({ loggedIn: false, country: "CN", asn: "99999" })).toBe("cn_other")
  })

  it("非 CN → overseas（不论是否已知机房 ASN）", () => {
    expect(decideTier({ loggedIn: false, country: "US", asn: "16509" })).toBe("overseas")
    expect(decideTier({ loggedIn: false, country: "JP", asn: "99999" })).toBe("overseas")
    expect(decideTier({ loggedIn: false, country: "HK", asn: "4134" })).toBe("overseas")
  })

  it("缺 country **或** 缺 ASN → unknown（最保守，plan §4）", () => {
    expect(decideTier({ loggedIn: false })).toBe("unknown")
    expect(decideTier({ loggedIn: false, country: "CN" })).toBe("unknown")
    expect(decideTier({ loggedIn: false, asn: "4134" })).toBe("unknown")
    expect(decideTier({ loggedIn: false, country: "", asn: "" })).toBe("unknown")
    expect(decideTier({ loggedIn: false, country: "XX", asn: "abc" })).toBe("unknown")
  })

  it("白名单/IDC 名单的边界：CN 白名单命中优先于 IDC（顺序不可颠倒）", () => {
    // 两个清单本身不重叠（防未来误加）
    for (const asn of CN_RESIDENTIAL_ASN) expect(CN_IDC_ASN.has(asn)).toBe(false)
    expect(CN_RESIDENTIAL_ASN.has("4134")).toBe(true)
    expect(CN_IDC_ASN.has("45102")).toBe(true)
  })
})

describe("limitForTier：env 覆盖与非法值兜底", () => {
  it("缺省 / 空 env → plan §4 默认值", () => {
    expect(limitForTier("logged_in")).toBe(60)
    expect(limitForTier("cn_residential", {})).toBe(30)
    expect(limitForTier("cn_other", {})).toBe(15)
    expect(limitForTier("cn_idc", {})).toBe(6)
    expect(limitForTier("overseas", {})).toBe(10)
    expect(limitForTier("unknown", {})).toBe(5)
    expect(limitForTier("unknown", undefined)).toBe(5)
    expect(limitForTier("unknown", null)).toBe(5)
  })

  it("env 覆盖各档（名字照 plan §4）", () => {
    const env = {
      RATE_LIMIT_LOGGED_IN_PER_MIN: "100",
      RATE_LIMIT_CN_RESIDENTIAL_PER_MIN: "40",
      RATE_LIMIT_CN_OTHER_PER_MIN: "12",
      RATE_LIMIT_CN_IDC_PER_MIN: "3",
      RATE_LIMIT_OVERSEAS_PER_MIN: "5", // plan §4 说境外"可调 5"
      RATE_LIMIT_UNKNOWN_PER_MIN: "1",
    }
    expect(limitForTier("logged_in", env)).toBe(100)
    expect(limitForTier("cn_residential", env)).toBe(40)
    expect(limitForTier("cn_other", env)).toBe(12)
    expect(limitForTier("cn_idc", env)).toBe(3)
    expect(limitForTier("overseas", env)).toBe(5)
    expect(limitForTier("unknown", env)).toBe(1)
  })

  it("非法值（0 / 负数 / NaN / 空白 / 非数字）→ 回默认值，不会把限流关掉", () => {
    for (const bad of ["0", "-1", "abc", "", "   ", "NaN", "Infinity"]) {
      expect(limitForTier("overseas", { RATE_LIMIT_OVERSEAS_PER_MIN: bad })).toBe(10)
    }
    // 小数向下取整（限流次数必须是整数）
    expect(limitForTier("overseas", { RATE_LIMIT_OVERSEAS_PER_MIN: "10.9" })).toBe(10)
  })
})

describe("llmLimitForTier：ceil(搜索/除数)，下限 1（plan §4.0）", () => {
  it("默认除数 5 的取整边界：60→12、30→6、15→3、6→2、10→2、5→1", () => {
    expect(llmLimitForTier("logged_in")).toBe(12)
    expect(llmLimitForTier("cn_residential")).toBe(6)
    expect(llmLimitForTier("cn_other")).toBe(3)
    expect(llmLimitForTier("cn_idc")).toBe(2) // ceil(6/5)=2
    expect(llmLimitForTier("overseas")).toBe(2) // ceil(10/5)=2
    expect(llmLimitForTier("unknown")).toBe(1) // ceil(5/5)=1
  })

  it("除数 4：30→8（ceil(7.5)）、60→15、6→2", () => {
    const env = { RATE_LIMIT_LLM_DIVISOR: "4" }
    expect(llmLimitForTier("cn_residential", env)).toBe(8)
    expect(llmLimitForTier("logged_in", env)).toBe(15)
    expect(llmLimitForTier("cn_idc", env)).toBe(2) // ceil(6/4)=2
    expect(llmLimitForTier("unknown", env)).toBe(2) // ceil(5/4)=2
  })

  it("下限恒为 1（取整绝不能变 0）", () => {
    expect(llmLimitForTier("unknown", { RATE_LIMIT_UNKNOWN_PER_MIN: "1", RATE_LIMIT_LLM_DIVISOR: "10" })).toBe(1)
    expect(llmLimitForTier("unknown", { RATE_LIMIT_UNKNOWN_PER_MIN: "2", RATE_LIMIT_LLM_DIVISOR: "999" })).toBe(1)
    expect(llmLimitForTier("cn_idc", { RATE_LIMIT_CN_IDC_PER_MIN: "1" })).toBe(1)
  })

  it("除数非法 → 回默认 5；除数 1 → 与搜索同额", () => {
    expect(llmDivisor({})).toBe(5)
    expect(llmDivisor({ RATE_LIMIT_LLM_DIVISOR: "0" })).toBe(5)
    expect(llmDivisor({ RATE_LIMIT_LLM_DIVISOR: "-3" })).toBe(5)
    expect(llmDivisor({ RATE_LIMIT_LLM_DIVISOR: "abc" })).toBe(5)
    expect(llmLimitForTier("overseas", { RATE_LIMIT_LLM_DIVISOR: "1" })).toBe(10)
  })

  it("LLM 限额随搜索限额联动（env 覆盖后仍按同一公式）", () => {
    const env = { RATE_LIMIT_OVERSEAS_PER_MIN: "30", RATE_LIMIT_LLM_DIVISOR: "4" }
    expect(limitForTier("overseas", env)).toBe(30)
    expect(llmLimitForTier("overseas", env)).toBe(8)
  })
})

describe("熔断阈值 env（plan §6）", () => {
  it("缺省 20 / 600 / 1200", () => {
    expect(burstPer10s({})).toBe(20)
    expect(anonGlobalLimit({})).toBe(600)
    expect(anonGlobalHardLimit({})).toBe(1200)
  })

  it("env 可覆盖；非法值回默认", () => {
    expect(burstPer10s({ BURST_PER_10S: "30" })).toBe(30)
    expect(anonGlobalLimit({ ANON_GLOBAL_PER_MIN: "100" })).toBe(100)
    expect(anonGlobalHardLimit({ ANON_GLOBAL_PER_MIN: "100", ANON_GLOBAL_HARD_PER_MIN: "300" })).toBe(300)
    expect(burstPer10s({ BURST_PER_10S: "0" })).toBe(20)
    expect(burstPer10s({ BURST_PER_10S: "x" })).toBe(20)
  })

  it("硬阈值恒 ≥ 软阈值（配置颠倒时抬到软阈值，避免「先硬后软」的诡异行为）", () => {
    expect(anonGlobalHardLimit({ ANON_GLOBAL_PER_MIN: "5000", ANON_GLOBAL_HARD_PER_MIN: "100" })).toBe(5000)
  })
})

describe("ASN 数据清单", () => {
  it("家宽白名单含电信/联通/移动/教育网骨干", () => {
    for (const asn of ["4134", "4809", "4837", "9929", "9808", "24400", "4538"]) {
      expect(CN_RESIDENTIAL_ASN.has(asn)).toBe(true)
    }
    expect(CN_RESIDENTIAL_ASN.has("56040")).toBe(true)
    expect(CN_RESIDENTIAL_ASN.has("56048")).toBe(true)
    expect(CN_RESIDENTIAL_ASN.has("56049")).toBe(false)
  })

  it("境外机房清单（诊断用）含 CF 自己的 13335（正是反代场景会被误读的那个 ASN）", () => {
    expect(OVERSEAS_HOSTING_ASN.has("13335")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("16509")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("15169")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("396982")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("8075")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("14061")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("20473")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("24940")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("16276")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("63949")).toBe(true)
    expect(OVERSEAS_HOSTING_ASN.has("31898")).toBe(true)
  })

  it("isKnownHostingAsn 归一化后判定（诊断位，不参与分档）", () => {
    expect(isKnownHostingAsn("AS13335")).toBe(true)
    expect(isKnownHostingAsn("13335")).toBe(true)
    expect(isKnownHostingAsn("4134")).toBe(false) // CN 家宽不在境外机房清单
    expect(isKnownHostingAsn(undefined)).toBe(false)
  })
})
