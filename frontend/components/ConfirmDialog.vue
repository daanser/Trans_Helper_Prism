<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 轻量二次确认弹窗（无第三方 UI 库）
     - 用于「开启 AI 伴读会消耗配额」等需要用户明确知情的操作
     - 支持 Esc / 点击遮罩关闭，打开时焦点落在确认按钮 -->
<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.self="onCancel"
        @keydown.esc="onCancel"
      >
        <div class="w-full max-w-md rounded-2xl border border-surface-border bg-surface p-5 shadow-floating sm:p-6">
          <h3 class="text-base font-semibold text-ink-title">{{ title }}</h3>
          <div class="mt-3 text-sm leading-relaxed text-ink-sub">
            <slot />
          </div>
          <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              ref="cancelBtn"
              type="button"
              class="rounded-lg border border-surface-border bg-surface px-4 py-2 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
              @click="onCancel"
            >
              {{ cancelText }}
            </button>
            <button
              type="button"
              class="rounded-lg px-4 py-2 text-xs font-medium text-white transition-colors"
              :class="danger ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:opacity-90'"
              @click="$emit('confirm')"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue"

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    confirmText?: string
    cancelText?: string
    /** 破坏性操作（删除等）用红色确认按钮；默认 false，不影响既有调用方 */
    danger?: boolean
  }>(),
  { confirmText: "确认", cancelText: "取消", danger: false },
)

const emit = defineEmits<{
  (e: "confirm"): void
  (e: "cancel"): void
}>()

const cancelBtn = ref<HTMLButtonElement | null>(null)

function onCancel() {
  emit("cancel")
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") onCancel()
}

watch(
  () => props.open,
  (open) => {
    if (typeof window === "undefined") return
    if (open) {
      nextTick(() => cancelBtn.value?.focus())
      window.addEventListener("keydown", onKeydown)
    } else {
      window.removeEventListener("keydown", onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  if (typeof window !== "undefined") window.removeEventListener("keydown", onKeydown)
})
</script>
