<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 根布局（app.vue）
     - 人文温润、专业严谨的跨社群知识检索平台
     - 优雅的导航栏与页脚，清晰的版权与免责声明 -->
<template>
  <div class="flex min-h-screen flex-col bg-canvas text-ink-body antialiased">
    <!-- 顶部导航栏 -->
    <header class="sticky top-0 z-50 border-b border-surface-border bg-surface/90 backdrop-blur-md">
      <div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <!-- 品牌标识 -->
        <NuxtLink to="/" class="group flex min-w-0 items-center gap-3 select-none" aria-label="TransHelper Prism 首页">
          <!-- 工作区 logo（六边形线框 + TP 字母）：深色徽底保证浅/暗色模式下白线框均清晰 -->
          <div class="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700/50 bg-slate-900 p-1 shadow-sm transition-transform group-hover:scale-95">
            <svg viewBox="0 0 500 500" class="h-full w-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <!-- 六边形线框 -->
              <polygon points="250,55 418.8,152.5 418.8,347.5 250,445 81.2,347.5 81.2,152.5" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linejoin="round" stroke-opacity="0.9" />
              <!-- TP 字母 -->
              <g fill="none" stroke-width="48" stroke-linecap="round" stroke-linejoin="round">
                <path d="M 145 185 L 215 185 M 180 185 L 180 315" stroke="#5BCEFA" />
                <path d="M 280 315 L 280 185 L 310 185 A 45 45 0 0 1 310 275 L 280 275" stroke="#F5A9B8" />
              </g>
            </svg>
          </div>
          <div class="flex flex-col">
            <span class="text-base font-bold tracking-tight text-ink-title">
              TransHelper Prism
            </span>
            <span class="text-[11px] text-ink-muted">
              跨社群文献语义检索
            </span>
          </div>
        </NuxtLink>

        <!-- 右侧操作区（布局改造 2026-09-12）：**常驻只留「设置」+「主题」**；
             外链、额度、退出、管理都收进下面的账号菜单（未登录 → 「更多 ⋯」菜单只放外链）。 -->
        <!-- 右侧操作区 `shrink-0`：窄屏时先让品牌区收缩，操作按钮永不被压变形（确定性布局） -->
        <div class="flex shrink-0 items-center gap-2">
          <NuxtLink
            to="/settings"
            class="inline-flex h-9 items-center rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
          >
            设置
          </NuxtLink>

          <!-- 账号菜单（点击触发器开合；Esc / 点空白处关闭；role=menu + aria-expanded） -->
          <div ref="menuRoot" class="relative">
            <button
              type="button"
              class="inline-flex h-9 max-w-[10rem] items-center gap-1.5 rounded-lg border border-surface-border bg-surface px-2.5 text-xs font-medium text-ink-title transition-colors hover:border-surface-border-hover"
              :aria-label="isLoggedIn ? `账号菜单（${user ? '@' + user.handle : '已登录'}）` : '更多'"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <template v-if="isLoggedIn">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[10px] font-semibold text-primary">
                  {{ userInitial }}
                </span>
                <span class="truncate">{{ user ? `@${user.handle}` : "已登录" }}</span>
              </template>
              <template v-else>
                <span>更多</span>
              </template>
              <svg class="h-3 w-3 shrink-0 text-ink-muted transition-transform" :class="menuOpen ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            <div
              v-if="menuOpen"
              role="menu"
              aria-label="账号菜单"
              class="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-surface-border bg-surface shadow-floating"
            >
              <!-- 额度（已登录且有数据时才有这一块）：百分比 + 距重置 -->
              <div v-if="isLoggedIn && hasQuotaInfo" class="border-b border-surface-border px-3 py-2.5" :title="quotaTitle">
                <div class="flex items-center justify-between gap-2 text-xs tabular-nums" :class="quotaToneClass">
                  <span class="flex items-center gap-1.5">
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="isExceeded || isLowQuota ? 'bg-danger' : 'bg-primary'"></span>
                    <span>{{ quotaLabel }}</span>
                  </span>
                  <span v-if="quotaResetHint" class="text-ink-muted">{{ quotaResetHint }}</span>
                </div>
                <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-canvas-subtle">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="isExceeded || isLowQuota ? 'bg-danger' : 'bg-primary'"
                    :style="{ width: `${remainingPct ?? 0}%` }"
                  ></div>
                </div>
              </div>

              <!-- 管理（仅管理员；原来平铺在顶栏，布局改造后收进菜单） -->
              <NuxtLink
                v-if="isAdmin"
                to="/admin"
                role="menuitem"
                class="block px-3 py-2 text-xs font-medium text-ink-sub transition-colors hover:bg-canvas-subtle hover:text-ink-title"
                @click="menuOpen = false"
              >
                管理后台
              </NuxtLink>

              <!-- 外链（未登录也在这里，不再平铺顶栏） -->
              <a
                href="https://transprism.chengxi.moe"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                class="flex items-center justify-between px-3 py-2 text-xs font-medium text-ink-sub transition-colors hover:bg-canvas-subtle hover:text-ink-title"
                @click="menuOpen = false"
              >
                <span>TransPrism</span>
                <span class="text-ink-muted" aria-hidden="true">↗</span>
              </a>
              <a
                href="https://transhelper.org"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                class="flex items-center justify-between border-b border-surface-border px-3 py-2 text-xs font-medium text-ink-sub transition-colors hover:bg-canvas-subtle hover:text-ink-title"
                @click="menuOpen = false"
              >
                <span>TransHelper</span>
                <span class="text-ink-muted" aria-hidden="true">↗</span>
              </a>

              <!-- 退出（仅登录态） -->
              <button
                v-if="isLoggedIn"
                type="button"
                role="menuitem"
                class="block w-full px-3 py-2 text-left text-xs font-medium text-ink-sub transition-colors hover:bg-canvas-subtle hover:text-danger"
                @click="onLogout"
              >
                退出登录
              </button>
            </div>
          </div>

          <!-- 未登录：保留「登录」按钮（顶栏常驻的第三个元素） -->
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>登录</span>
          </NuxtLink>

          <!-- 深浅色主题切换按钮 -->
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-lg border border-surface-border bg-surface text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
            :aria-label="isDark ? '切换至亮色模式' : '切换至暗色模式'"
            @click="toggleDark"
          >
            <!-- 太阳图标 -->
            <svg v-if="!isDark" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
            <!-- 月亮图标 -->
            <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <!-- 页面主体路由出口 -->
    <main class="flex-1">
      <NuxtPage />
    </main>

    <!-- 底部页脚 -->
    <footer class="mt-16 border-t border-surface-border bg-surface py-8">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-sub">
          <span class="font-semibold text-ink-title">TransHelper Prism</span>
          <span aria-hidden="true">·</span>
          <span>GPL-3.0 开源协议</span>
          <span aria-hidden="true">·</span>
          <NuxtLink to="/about" class="text-primary hover:underline">关于与免责</NuxtLink>
          <span aria-hidden="true">·</span>
          <!-- 从搜索卡下方移到页脚：主操作与推荐查询之间不再被合规行切断；
               首次访问仍有免责弹窗做显式确认，这里是常驻的"随时可查"入口 -->
          <span>
            继续使用本站即表示你已阅读并同意
            <NuxtLink to="/about" class="text-primary hover:underline">免责声明与使用须知</NuxtLink>
          </span>
          <span aria-hidden="true">·</span>
          <a
            href="https://transprism.chengxi.moe"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
          >
            TransPrism
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://transhelper.org"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
          >
            TransHelper
          </a>
        </div>
        <div class="text-xs text-ink-muted">
          本平台条目仅供参考学习，医疗指引请务必以执业医生诊断为准。
        </div>
      </div>
    </footer>

    <!-- 全局轻量 Toast 提示 -->
    <Toast />

    <!-- 免责声明弹窗：任何页面首次访问都弹（含 /about、/login）；判定链见 useDisclaimer.ts -->
    <DisclaimerDialog />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useDarkMode } from "~/composables/useDarkMode"
import { describeAuthError } from "~/composables/useAuth"
import DisclaimerDialog from "~/components/DisclaimerDialog.vue"

const { isDark, toggle: toggleDark } = useDarkMode()
const {
  isLoggedIn,
  isAdmin,
  user,
  hasQuotaInfo,
  remainingPct,
  isLowQuota,
  isExceeded,
  resetInHours,
  resetAtLabel,
  init,
  loadMe,
  consumeHashToken,
  logout,
} = useAuth()
const { pushToast } = useToast()
const route = useRoute()

// ── 账号菜单（布局改造）：点击开合；Esc 与"点空白处"关闭 ──
const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)

/** 头像里的首字母（handle 为空时退化为「我」） */
const userInitial = computed(() => (user.value?.handle ?? "").trim().charAt(0).toUpperCase() || "我")

function onDocPointerDown(ev: MouseEvent) {
  if (!menuOpen.value) return
  const root = menuRoot.value
  if (root && ev.target instanceof Node && root.contains(ev.target)) return // 点在菜单内部 → 不关
  menuOpen.value = false
}
function onDocKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && menuOpen.value) menuOpen.value = false
}

onMounted(() => {
  if (typeof window === "undefined") return
  window.addEventListener("pointerdown", onDocPointerDown)
  window.addEventListener("keydown", onDocKeydown)
})
onBeforeUnmount(() => {
  if (typeof window === "undefined") return
  window.removeEventListener("pointerdown", onDocPointerDown)
  window.removeEventListener("keydown", onDocKeydown)
})

/** 顶栏配额文案：只出现百分比（绝不出现绝对 token 数） */
const quotaLabel = computed(() => {
  if (isExceeded.value) return "额度已用尽"
  const pct = remainingPct.value
  return pct === null ? "" : `剩余 ${pct.toFixed(1)}%`
})

/** 「· x 小时后重置」半句；后端未给重置字段（旧契约）时为 null，整句不显示 */
const quotaResetHint = computed(() => {
  const hours = resetInHours.value
  if (hours === null) return null
  return `${hours} 小时后重置`
})

const quotaToneClass = computed(() => {
  if (isExceeded.value || isLowQuota.value) return "font-medium text-danger"
  return "text-ink-sub"
})

const quotaTitle = computed(() => {
  const hours = resetInHours.value
  const at = resetAtLabel.value // 仅客户端（HH:MM），预渲染阶段为 null
  const when = hours ? (at ? `将于 ${at}（约 ${hours} 小时后）` : `约 ${hours} 小时后`) : ""
  if (isExceeded.value) {
    return `本窗口额度已用尽，${when ? when + "恢复" : "等待窗口重置"}。回退检索不消耗额度。`
  }
  const pct = remainingPct.value
  if (pct === null) return "尚未读取到配额信息"
  const reset = when ? `本窗口${when}重置。` : ""
  // 顶栏只讲"余额 + 何时重置"；额度规则（什么消耗、什么不消耗）归到对应功能旁边（用户反馈 #4）
  return `本窗口剩余额度 ${pct.toFixed(1)}%。${reset}`

})

function onLogout() {
  menuOpen.value = false
  logout()
  pushToast("已退出登录", "info")
  if (route.path === "/settings" || route.path === "/admin") {
    void navigateTo("/")
  }
}

onMounted(() => {
  // 登录回跳：任意页面都可能带 #token= / #error=（见 useAuth.consumeHashToken）
  const hashResult = consumeHashToken()
  if (hashResult?.error) {
    pushToast(describeAuthError(hashResult.error), "error")
  }
  const hasSession = hashResult?.token ? true : init()
  if (hasSession) {
    void loadMe()
  }
})
</script>
