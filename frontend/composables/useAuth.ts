// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 账号会话与配额状态（tasks.md T3.6）
// - token 只落 localStorage（见 utils/authToken.ts），绝不打印、绝不落 URL 历史
// - user / quota 用 useState 暴露响应式，顶栏与页面共用同一份
// - 登录走浏览器顶层跳转（不是 fetch）：GET {apiBase}/v1/auth/oauth/x/start?redirect=<回跳地址>
// - 后端契约（已上线）：GET /api/v1/me → {user, quota}；无 token → 401 {error:"unauthorized"}

import type { MeUser, QuotaState } from "~/composables/useApi"
import { readAuthToken, writeAuthToken } from "~/utils/authToken"

/** GET /api/v1/me 的 user 字段（别名，保持既有引用） */
export type AuthUser = MeUser

/**
 * 配额（T3.2 新契约）：滚动窗口固定额度，前端只显示百分比。
 * 字段全部可选 —— 后端未实现 / 字段缺失时前端降级为「不显示配额块」，绝不报错、绝不阻断检索。
 */
export type AuthQuota = QuotaState

/** 登录回跳 fragment 的解析结果 */
export interface HashAuthResult {
  token?: string
  error?: string
}

/** 后端 auth 失败码 → 中文说明（不透传任何内部细节） */
export function describeAuthError(code: string): string {
  const map: Record<string, string> = {
    unauthorized: "登录状态无效，请重新登录",
    "missing-code-or-state": "授权回调参数缺失，请重新登录",
    "oauth-callback-failed": "授权失败，请稍后重试",
    "oauth-start-failed": "无法发起授权，请稍后重试",
    "x-oauth-unconfigured": "登录服务暂未配置完成",
    "db-unconfigured": "账号服务暂不可用",
    "db-unavailable": "账号服务暂不可用",
    "account-banned": "该账号已被封禁",
    "account-suspended": "该账号已被暂停",
    "state-expired": "授权已超时，请重新登录",
    "invalid-state": "授权校验失败，请重新登录",
  }
  return map[code] ?? `登录失败（${code}）`
}

/**
 * 账号会话状态。
 * 注意：所有本地存储访问都在客户端守卫内，`nuxt generate` 预渲染安全。
 */
export function useAuth() {
  const token = useState<string | null>("prism:auth:token", () => null)
  const user = useState<AuthUser | null>("prism:auth:user", () => null)
  const quota = useState<AuthQuota | null>("prism:auth:quota", () => null)
  const loading = useState<boolean>("prism:auth:loading", () => false)
  const authError = useState<string>("prism:auth:error", () => "")

  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.role === "admin")

  /** 剩余百分比（0–100，1 位小数）；无数据时 null */
  const remainingPct = computed<number | null>(() => {
    const q = quota.value
    if (!q) return null
    const direct = typeof q.remaining_pct === "number" && Number.isFinite(q.remaining_pct) ? q.remaining_pct : null
    if (direct !== null) return clampPct(direct)
    if (typeof q.used_pct === "number" && Number.isFinite(q.used_pct)) return clampPct(100 - q.used_pct)
    return null
  })

  /** 是否拿到可展示的配额信息（缺字段 / 404 → false，UI 直接不渲染配额块） */
  const hasQuotaInfo = computed(() => remainingPct.value !== null)

  /** 已用百分比（0–100）；无数据时 null */
  const usedPct = computed<number | null>(() => {
    const q = quota.value
    if (!q) return null
    if (typeof q.used_pct === "number" && Number.isFinite(q.used_pct)) return clampPct(q.used_pct)
    const rem = remainingPct.value
    return rem === null ? null : clampPct(100 - rem)
  })

  /** 滚动窗口是否已耗尽 */
  const isExceeded = computed(() => quota.value?.exceeded === true)

  /** 低于 10% 触发前端警示色（T3.6） */
  const isLowQuota = computed(() => {
    const rem = remainingPct.value
    return rem !== null && rem < 10
  })

  /** 窗口恢复所需小时数：ceil((window_start + window_hours*3600e3 - now) / 3600e3)，至少 1 */
  const resetInHours = computed<number | null>(() => {
    const q = quota.value
    if (!q || typeof q.window_start !== "number" || typeof q.window_hours !== "number") return null
    const endMs = q.window_start + q.window_hours * 3600e3
    return Math.max(1, Math.ceil((endMs - Date.now()) / 3600e3))
  })

  function getToken(): string | null {
    if (!token.value) token.value = readAuthToken()
    return token.value
  }

  function setToken(value: string | null) {
    token.value = value
    writeAuthToken(value)
  }

  /** 首次进入时把 localStorage 的 token 同步进响应式状态（仅客户端） */
  function init(): boolean {
    const stored = readAuthToken()
    if (stored) token.value = stored
    return !!stored
  }

  /** 发起 X OAuth 登录：顶层跳转，不在 fetch 里做 */
  function login(redirectTo?: string) {
    if (typeof window === "undefined") return
    const base = (useRuntimeConfig().public.apiBase as string) || "/api"
    let after = redirectTo
    if (!after) {
      // 回跳当前页（不含 hash），登录后 token 以 fragment 形式回到同一页，由 consumeHashToken 接管
      after = `${window.location.origin}${window.location.pathname}${window.location.search}`
    }
    window.location.href = `${base}/v1/auth/oauth/x/start?redirect=${encodeURIComponent(after)}`
  }

  /** 退出登录：清内存 + 清 localStorage（token 是唯一凭据） */
  function logout() {
    setToken(null)
    user.value = null
    quota.value = null
    authError.value = ""
  }

  /** 拉取当前账号与配额；401/403 视为会话失效并自动清理 */
  async function loadMe(): Promise<boolean> {
    if (!getToken()) {
      user.value = null
      quota.value = null
      return false
    }
    loading.value = true
    try {
      const res = await useApi().me()
      user.value = res.user
      quota.value = res.quota
      authError.value = ""
      return true
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status
      if (status === 401 || status === 403) {
        const wasLoggedIn = !!token.value
        logout()
        authError.value = status === 403 ? "该账号当前不可用，请重新登录或联系管理员" : wasLoggedIn ? "登录已过期，请重新登录" : ""
      } else {
        authError.value = (err as Error)?.message || "无法获取账号信息"
      }
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 读取并清除 location.hash 里的登录结果（`#token=` / `#error=`）。
   * 读完立刻 replaceState 抹掉 hash：token 不进浏览器历史、不被复制分享出去。
   */
  function consumeHashToken(): HashAuthResult | null {
    if (typeof window === "undefined") return null
    const raw = window.location.hash.replace(/^#/, "")
    if (!raw) {
      // 兜底：nuxt.config 的启动前内联脚本可能已消费 hash 并把 error 存进 sessionStorage
      try {
        const stashed = window.sessionStorage.getItem("prism_auth_error")
        if (stashed) {
          window.sessionStorage.removeItem("prism_auth_error")
          return { error: stashed }
        }
      } catch {
        /* ignore */
      }
      return null
    }
    const params = new URLSearchParams(raw)
    const tokenValue = params.get("token")
    const errorValue = params.get("error")
    if (!tokenValue && !errorValue) return null

    // 保留 vue-router 写入的 history.state，避免「manually replaced」告警
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)

    if (tokenValue) {
      setToken(tokenValue)
      return { token: tokenValue }
    }
    return { error: errorValue ?? "unknown" }
  }

  return {
    token,
    user,
    quota,
    loading,
    authError,
    isLoggedIn,
    isAdmin,
    hasQuotaInfo,
    remainingPct,
    usedPct,
    isLowQuota,
    isExceeded,
    resetInHours,
    getToken,
    setToken,
    init,
    login,
    logout,
    loadMe,
    consumeHashToken,
  }
}

/** 百分比收敛到 0–100 并保留 1 位小数 */
function clampPct(value: number): number {
  const clamped = Math.max(0, Math.min(100, value))
  return Math.round(clamped * 10) / 10
}
