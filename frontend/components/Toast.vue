<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — Toast: 瑞士发丝线悬浮通知 -->
<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex w-[min(92vw,28rem)] -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="pointer-events-auto flex w-full items-center gap-3 border bg-surface px-4 py-3 text-xs shadow-flat transition-all"
          :class="toneClass(t.tone)"
          role="status"
        >
          <span class="font-mono text-[10px] font-semibold tracking-wider uppercase" :class="tagClass(t.tone)">
            {{ tagText(t.tone) }} //
          </span>
          <span class="flex-1 font-medium leading-relaxed text-ink-primary">{{ t.message }}</span>
          <button
            type="button"
            class="p-1 font-mono text-xs text-ink-muted transition-colors hover:text-ink-primary"
            aria-label="关闭通知"
            @click="dismiss(t.id)"
          >
            ✕
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast, type ToastItem } from "~/composables/useToast"

const { toasts, dismissToast } = useToast()

function toneClass(tone: ToastItem["tone"]): string {
  switch (tone) {
    case "warning":
      return "border-signal text-signal"
    case "error":
      return "border-danger text-danger"
    default:
      return "border-hairline-strong text-ink-primary"
  }
}

function tagText(tone: ToastItem["tone"]): string {
  switch (tone) {
    case "warning":
      return "NOTE"
    case "error":
      return "FAIL"
    default:
      return "INFO"
  }
}

function tagClass(tone: ToastItem["tone"]): string {
  switch (tone) {
    case "warning":
      return "text-signal"
    case "error":
      return "text-danger"
    default:
      return "text-ink-muted"
  }
}

function dismiss(id: number) {
  dismissToast(id)
}
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
