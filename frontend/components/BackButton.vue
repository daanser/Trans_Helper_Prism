<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — BackButton: 子页面左上角统一「返回」按键（无第三方图标库）
     - 智能返回：vue-router 4 会把站内来源页写进 history.state.back。
       有站内来源才 router.back()；直接打开链接（OAuth 回跳 #token=、别人分享的 /settings）
       时 history.state.back 为空，此时回首页，绝不把人弹出站外。
     - 无障碍：<button> 原生可键盘触发，aria-label + :focus-visible 焦点环，点击区 ≥ 36px
     - 主题：只用 surface / ink-* / primary 语义 token，浅色与深色均自适应（不写死浅色） -->
<template>
  <button
    type="button"
    :aria-label="ariaLabel"
    class="inline-flex h-9 min-w-[4.5rem] items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-ink-sub shadow-card transition-colors hover:border-surface-border-hover hover:text-ink-title focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    @click="goBack"
  >
    <svg
      class="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
    <span>{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    /** 强制指定返回目标；缺省走智能返回（站内来源 → back()，否则首页） */
    to?: string
    /** 按钮文案，缺省「返回」 */
    label?: string
  }>(),
  { to: "", label: "返回" },
)

const router = useRouter()

/** 无障碍名称：明确说明是「上一页」，而不是普通按钮 */
const ariaLabel = computed(() => (props.to ? `返回上一页（${props.to}）` : "返回上一页"))

// 预渲染（SSR）时不碰 window；点击只发生在客户端
function goBack() {
  if (props.to) {
    void router.push(props.to)
    return
  }
  if (import.meta.client) {
    // vue-router 4 会把来源写进 history.state.back；有站内来源才 back()，否则回首页
    const back = (window.history.state as { back?: string | null } | null)?.back
    if (back) router.back()
    else void router.push("/")
  }
}
</script>
