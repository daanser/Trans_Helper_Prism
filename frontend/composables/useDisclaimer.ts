// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 免责声明的"弹不弹 / 记住了没"状态（useState 共享）
//
// ── 背景（用户反馈）──
// /about 上线后免责声明只藏在页脚 ≈ 等于没有。改为**首次访问默认弹窗**，并提供
// 「我知道了，不再提示」——记住这件事要**本地缓存 + 账号数据双写**（换设备不再弹）。
//
// ── 判定链（shouldShow 为真才弹；任一条件成立即不弹）──
//   1. `acked`            本地已确认（localStorage，**版本化**：见下方"文案大改"）
//   2. `dismissedSession` 本次会话点过「本次关闭」（sessionStorage，关掉标签页就失效）
//   3. `serverAck`        已登录且服务端 `accounts.disclaimer_ack_at` 非空（换设备不再弹的依据）
//   4. `!ready`           还没在客户端读完存储 —— **SSR/预渲染期恒不弹**，避免静态产物里
//                         先渲染出弹窗、水合后又因 localStorage 已确认而消失（闪一下）
//
// ── 存储与版本（重要，改文案时先读这段）──
//   · localStorage  `prism_disclaimer_ack`     = "v1"（**只存版本串，不存时间/不存 PII**）
//   · sessionStorage `prism_disclaimer_session` = "v1"
//   **文案大改时把 `DISCLAIMER_VERSION` 从 v1 改成 v2 即可让所有人重新看到一次**
//   （旧值 "v1" ≠ "v2" → 视为未确认）。这也顺带解决了"忘了清缓存"的问题。
//
// ── 隐私与失败策略 ──
//   · 不进 URL、不进日志、不打印任何凭据；`prism_disclaimer_*` 两个键都不含账号标识。
//   · 服务端同步（`POST /v1/me/disclaimer`）**只在登录态发生**；任何失败只 `console.warn`，
//     **绝不影响本地状态**（本地已记住就是记住了，网络问题不该让用户被反复打扰）。
//   · 所有 `window` / `localStorage` / `sessionStorage` 访问都在 `import.meta.client` + try/catch 里：
//     预渲染、隐私模式（存储被禁用）下都不抛错，最差退化为"本次会话每次都弹"。

import type { MeResponse } from "~/composables/useApi"
import { readAuthToken } from "~/utils/authToken"

/**
 * 声明版本。**文案大改时改这里**（v1 → v2）：所有人（含已确认的用户）会重新看到一次弹窗。
 * 同时它也是两个存储键的值 —— 只存版本串，不存任何时间戳或账号信息。
 */
export const DISCLAIMER_VERSION = "v1"

/** localStorage 键：只要 === DISCLAIMER_VERSION 就表示"这台设备上已确认"。 */
export const DISCLAIMER_LS_KEY = "prism_disclaimer_ack"

/** sessionStorage 键：本次会话已关闭（关掉标签页即失效）。 */
export const DISCLAIMER_SS_KEY = "prism_disclaimer_session"

/** 安全读存储（预渲染 / 隐私模式下返回 null，绝不抛错）。 */
function readStore(kind: "local" | "session", key: string): string | null {
  if (!import.meta.client) return null
  try {
    const store = kind === "local" ? window.localStorage : window.sessionStorage
    return store.getItem(key)
  } catch {
    return null
  }
}

/** 安全写存储（失败静默：本次会话内存态仍然生效）。 */
function writeStore(kind: "local" | "session", key: string, value: string | null): void {
  if (!import.meta.client) return
  try {
    const store = kind === "local" ? window.localStorage : window.sessionStorage
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    /* 存储不可用：忽略 */
  }
}

/** 状态形状（供单测/调试阅读；useState 键统一 `prism:disclaimer:*`） */
export interface DisclaimerState {
  /** 本设备已确认（localStorage 命中当前版本） */
  acked: boolean
  /** 本次会话已关闭 */
  dismissedSession: boolean
  /** 服务端已记录确认（仅登录后可能为 true） */
  serverAck: boolean
  /** 已在客户端读完存储（预渲染期为 false，故预渲染期不弹） */
  ready: boolean
}

export function useDisclaimer() {
  const acked = useState<boolean>("prism:disclaimer:acked", () => false)
  const dismissedSession = useState<boolean>("prism:disclaimer:dismissed", () => false)
  const serverAck = useState<boolean>("prism:disclaimer:server-ack", () => false)
  const ready = useState<boolean>("prism:disclaimer:ready", () => false)

  /**
   * 是否该弹窗。见文件头"判定链"。
   * 注意 `serverAck` 只在**登录后**由 `syncFromAccount()` 写入，因此它自带"已登录"语义，
   * 这里不必再引 useAuth（避免 useAuth ↔ useDisclaimer 循环依赖）。
   */
  const shouldShow = computed(
    () => ready.value && !acked.value && !dismissedSession.value && !serverAck.value,
  )

  /** 设置页开关的模型：ON = 启动时显示（即"尚未记住"）。 */
  const showOnStart = computed(() => !acked.value)

  /**
   * 客户端读一次存储（幂等；预渲染期直接返回，不碰 window）。
   * 由 `DisclaimerDialog` 挂载时与设置页调用。
   */
  function load(): DisclaimerState {
    if (!import.meta.client) return snapshot()
    acked.value = readStore("local", DISCLAIMER_LS_KEY) === DISCLAIMER_VERSION
    dismissedSession.value = readStore("session", DISCLAIMER_SS_KEY) === DISCLAIMER_VERSION
    ready.value = true
    return snapshot()
  }

  function snapshot(): DisclaimerState {
    return {
      acked: acked.value,
      dismissedSession: dismissedSession.value,
      serverAck: serverAck.value,
      ready: ready.value,
    }
  }

  /**
   * 把"已确认"同步到服务端（只在登录态、只有拿到 token 时才发）。
   * **失败只 warn**：本地状态已经写好了，网络问题不该让用户被反复弹。
   */
  async function pushToServer(ack: boolean): Promise<void> {
    if (!import.meta.client) return
    if (!readAuthToken()) return // 未登录：只本地生效（服务端 ack 只对账号有意义）
    try {
      await useApi().ackDisclaimer(ack)
    } catch (err: unknown) {
      console.warn("[disclaimer] 同步到账号失败（仅本地生效）：", (err as Error)?.message ?? String(err))
    }
  }

  /** 主按钮「我知道了，不再提示」：写两处存储 + （已登录时）同步服务端。 */
  function ack(): DisclaimerState {
    acked.value = true
    dismissedSession.value = true
    writeStore("local", DISCLAIMER_LS_KEY, DISCLAIMER_VERSION)
    writeStore("session", DISCLAIMER_SS_KEY, DISCLAIMER_VERSION)
    void pushToServer(true)
    return snapshot()
  }

  /** 次按钮「本次关闭」/ Esc：只写 sessionStorage，下次访问还会弹。 */
  function dismissForSession(): DisclaimerState {
    dismissedSession.value = true
    writeStore("session", DISCLAIMER_SS_KEY, DISCLAIMER_VERSION)
    return snapshot()
  }

  /**
   * 撤销确认（设置页开关 ON；也用于"我想再看一遍"）。
   * 清两处存储（下次启动会弹）+ 同步服务端 `{ack:false}`；
   * 但**内存里把本次会话标记为已关闭**：否则用户在设置页把开关拨到 ON 的瞬间，
   * 弹窗会立刻盖住设置页本身（开关的语义是"启动时显示"，不是"现在立刻弹"）。
   */
  function resetAck(): DisclaimerState {
    acked.value = false
    writeStore("local", DISCLAIMER_LS_KEY, null)
    writeStore("session", DISCLAIMER_SS_KEY, null)
    dismissedSession.value = true
    void pushToServer(false)
    return snapshot()
  }

  /**
   * `loadMe()` 成功后调用：服务端说"确认过" → 补写本地（**换设备不再弹**）。
   * 服务端说"没确认"时**不清本地**：本地确认可能来自"这台设备上确认过但同步失败"，
   * 那种情况下反复弹窗才是 bug（服务端不可用时不该惩罚用户）。
   */
  function syncFromAccount(me: Pick<MeResponse, "disclaimer_ack" | "disclaimer_ack_at"> | null | undefined): DisclaimerState {
    const server = me?.disclaimer_ack === true || typeof me?.disclaimer_ack_at === "number"
    serverAck.value = server
    if (server) {
      acked.value = true
      writeStore("local", DISCLAIMER_LS_KEY, DISCLAIMER_VERSION)
    }
    return snapshot()
  }

  /** 登出/换账号时清掉"服务端已确认"的内存态（下次 loadMe 重新同步，避免串号）。 */
  function clearServerAck(): void {
    serverAck.value = false
  }

  /** 设置页开关：`on=true` → 启动时显示（撤销确认）；`on=false` → 不再提示（确认）。 */
  function setShowOnStart(on: boolean): DisclaimerState {
    return on ? resetAck() : ack()
  }

  return {
    acked,
    dismissedSession,
    serverAck,
    ready,
    shouldShow,
    showOnStart,
    load,
    ack,
    dismissForSession,
    resetAck,
    syncFromAccount,
    clearServerAck,
    setShowOnStart,
  }
}
