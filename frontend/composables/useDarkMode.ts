// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 深色模式 composable
// 全局响应式状态（useState）+ Cookie/localStorage 双持久化 + 客户端实时 DOM 同步
// 移植自 project-trans / VitePress 核心模式切换规范

export function useDarkMode() {
  const cookieMode = useCookie<string>("dark-mode", {
    default: () => "",
    watch: true,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    path: "/",
  })

  // 全局响应式状态，解决 SSR / 多组件共享时的响应性断裂
  const isDark = useState<boolean>("prism-is-dark", () => {
    if (cookieMode.value === "dark") return true
    if (cookieMode.value === "light") return false
    if (import.meta.client) {
      return document.documentElement.classList.contains("dark")
    }
    return false
  })

  function applyDomTheme(dark: boolean) {
    if (!import.meta.client) return
    const el = document.documentElement
    if (dark) {
      el.classList.add("dark")
    } else {
      el.classList.remove("dark")
    }
    try {
      localStorage.setItem("dark-mode", dark ? "dark" : "light")
    } catch (_) {}
  }

  function set(dark: boolean) {
    isDark.value = dark
    cookieMode.value = dark ? "dark" : "light"
    applyDomTheme(dark)
  }

  function toggle() {
    set(!isDark.value)
  }

  function clearPreference() {
    cookieMode.value = ""
    try {
      localStorage.removeItem("dark-mode")
    } catch (_) {}
    if (import.meta.client) {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      isDark.value = prefersDark
      applyDomTheme(prefersDark)
    }
  }

  if (import.meta.client) {
    onMounted(() => {
      // 客户端挂载后与真实 DOM / 本地偏好做一次最终校准
      let currentDark = document.documentElement.classList.contains("dark")
      if (cookieMode.value === "dark") {
        currentDark = true
      } else if (cookieMode.value === "light") {
        currentDark = false
      } else {
        try {
          const local = localStorage.getItem("dark-mode")
          if (local === "dark") currentDark = true
          else if (local === "light") currentDark = false
          else currentDark = window.matchMedia("(prefers-color-scheme: dark)").matches
        } catch (_) {
          currentDark = window.matchMedia("(prefers-color-scheme: dark)").matches
        }
      }
      isDark.value = currentDark
      applyDomTheme(currentDark)

      // 监听系统主题变化（仅在未手动锁定时联动）
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const handleSystemChange = (e: MediaQueryListEvent) => {
        let hasLocal = false
        try {
          hasLocal = Boolean(localStorage.getItem("dark-mode"))
        } catch (_) {}
        if (!cookieMode.value && !hasLocal) {
          isDark.value = e.matches
          applyDomTheme(e.matches)
        }
      }
      mediaQuery.addEventListener("change", handleSystemChange)
      onUnmounted(() => mediaQuery.removeEventListener("change", handleSystemChange))
    })
  }

  return { isDark, toggle, set, clearPreference }
}
