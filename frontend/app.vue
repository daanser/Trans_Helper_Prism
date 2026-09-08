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
        <NuxtLink to="/" class="group flex items-center gap-3 select-none" aria-label="TransHelper Prism 首页">
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

        <!-- 右侧外链与操作 -->
        <div class="flex items-center gap-3">
          <a
            href="https://transprism.chengxi.moe"
            target="_blank"
            rel="noopener noreferrer"
            class="hidden rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title sm:inline-flex sm:items-center sm:gap-1"
          >
            <span>TransPrism</span>
            <svg class="h-3.5 w-3.5 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>

          <a
            href="https://transhelper.org"
            target="_blank"
            rel="noopener noreferrer"
            class="hidden rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title sm:inline-flex sm:items-center sm:gap-1"
          >
            <span>TransHelper</span>
            <svg class="h-3.5 w-3.5 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>

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
  </div>
</template>

<script setup lang="ts">
import { useDarkMode } from "~/composables/useDarkMode"

const { isDark, toggle: toggleDark } = useDarkMode()
</script>
