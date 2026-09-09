// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 会话 token 的唯一落点（tasks.md T3.6）
// 只存 localStorage（键 `prism_token`）：不进 cookie（避免随请求自动携带到第三方）、
// 不进 URL 历史（登录回跳的 #token= 读完立刻清）、不进日志、绝不打印。
// 该模块不依赖任何 Nuxt 组合式函数，useApi / useAuth 都从这里读写，避免循环依赖。

/** localStorage 键名（与后端回跳 fragment `#token=` 约定区分开） */
export const AUTH_TOKEN_KEY = "prism_token"

function storage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    // 隐私模式/被禁用时降级为「本次会话不持久化」
    return null
  }
}

/** 读取本地会话 token；服务端渲染（预渲染）时恒为 null */
export function readAuthToken(): string | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(AUTH_TOKEN_KEY)
    return raw && raw.trim() ? raw.trim() : null
  } catch {
    return null
  }
}

/** 写入/清除本地会话 token（传 null 即登出） */
export function writeAuthToken(token: string | null): void {
  const s = storage()
  if (!s) return
  try {
    if (token) s.setItem(AUTH_TOKEN_KEY, token)
    else s.removeItem(AUTH_TOKEN_KEY)
  } catch {
    // 存储不可写：忽略，用户本次会话仍可用内存态 token
  }
}

/** 生成带 Bearer 前缀的 Authorization 头；无 token 返回空对象 */
export function authHeader(): Record<string, string> {
  const token = readAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
