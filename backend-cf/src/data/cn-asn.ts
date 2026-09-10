// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — ASN 清单（分档限流用；plan-ratelimit.md §4.1）
//
// ⚠️⚠️ **这是初始清单，不是全量，需按线上数据校准** ⚠️⚠️
// 省/地市级的 ASN 数以千计（仅中国移动就有 `56040`~`56048` 这类按省分配的段），
// 手写清单**必然**既漏又错。本文件的作用是「先给一个保守起点」，不是「权威数据库」。
//
// ── 校准方法（plan §4.1，别在这里拍脑袋加号）──
// 1. 取公开数据：APNIC delegated 文件 / iptoasn 数据（ASN ↔ 前缀 ↔ 组织名）；
// 2. 只保留 country=CN 的前缀，按 `asOrganization` 关键词粗筛：
//      家宽/移动： Chinanet | China Telecom | China Unicom | China Mobile | CMNET | CERNET | Broadband
//      机房/IDC ： Cloud | Alibaba | Tencent | Huawei Cloud | IDC | Data Center | Vultr | DigitalOcean ...
// 3. 生成「CN 非 IDC ASN」清单（脚本产物随代码评审更新，含来源与生成时间）；
// 4. 上线后用 `/api/v1/admin/whoami` + `/admin/usage` 观察各档命中分布，再回来调整。
//
// ── 语义边界（重要）──
// · 白名单 ≠ 可信：**有 IDC 从电信 ASN 广播**，白名单只表示「放宽一档」（30/min 而不是 6/min），
//   真正的兜底是熔断（§6）与 5h 配额（quota.ts）。
// · 清单里的值一律是**纯数字字符串**（`"4134"`，不带 `AS` 前缀）；比较前由 tiers.ts 归一化，
//   所以这里写 `AS4134` 也不会错，但请保持纯数字，便于人工校对。
// · 本文件是**纯数据**（无 IO、无逻辑），可被任何模块静态引入：Worker 打包后是常量表，零运行时成本。

/**
 * CN 家宽 / 移动 / 教育网 ASN 白名单（**初始值**，见文件头校准方法）。
 * 命中 → `cn_residential` 档（默认 30 次/分钟）。
 */
export const CN_RESIDENTIAL_ASN: ReadonlySet<string> = new Set<string>([
  // 中国电信
  "4134", // CHINANET（电信骨干）
  "4809", // CN2 / CTGI（电信国际精品网）
  // 中国联通
  "4837", // CHINA169（联通骨干）
  "9929", // CUII（联通国际）
  // 中国移动
  "9808", // CMNET（移动骨干）
  ...Array.from({ length: 9 }, (_, i) => String(56040 + i)), // 56040~56048：各省移动
  "24400", // 中国移动（部分省网/国际）
  // 教育网
  "4538", // CERNET（校园网按非机房放宽）
])

/**
 * CN 云 / IDC ASN（**收紧用**）：命中 → `cn_idc` 档（默认 **6** 次/分钟，刻意低于境外）。
 * 正常人不会用机房 IP 连站，而机房 IP 是攻击主力（本项目曾被打过，见 history.md）。
 */
export const CN_IDC_ASN: ReadonlySet<string> = new Set<string>([
  "45102", // 阿里云
  "37963", // 阿里云国际
  "132203", // 腾讯云
  "45090", // 腾讯
  "136907", // 华为云
  "135377", // UCloud
  "55967", // 百度云
])

/**
 * 境外常见云 / 托管 ASN（**诊断用**：whoami 会标注 `hosting_asn`）。
 *
 * 说明：当前分档规则里「非 CN」一律落 `overseas`（10/min），**不区分**是否机房
 * （plan §4：境外的正常读者比机房攻击者多，所以不额外收紧）。本清单因此**不参与 decideTier**，
 * 只用于：
 *   · whoami 诊断（看清对面到底是家宽还是云主机，便于人工判断是否要调阈值）；
 *   · 将来若要给「境外机房」单独收一档，直接在这里取数据即可。
 */
export const OVERSEAS_HOSTING_ASN: ReadonlySet<string> = new Set<string>([
  "16509", // AWS
  "15169", // Google
  "396982", // Google Cloud
  "8075", // Microsoft Azure
  "14061", // DigitalOcean
  "20473", // Vultr
  "24940", // Hetzner
  "16276", // OVH
  "63949", // Linode / Akamai
  "31898", // Oracle Cloud
  "13335", // Cloudflare（⚠️ 经 Pages Function 反代时，Worker 的 request.cf 就是这个值 —— 正是 §3 要解决的问题）
])
