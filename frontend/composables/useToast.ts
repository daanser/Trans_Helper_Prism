// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 轻量 toast 状态（无第三方 UI 库）
// 提供全局 toast 队列，由 components/Toast.vue 渲染。

export interface ToastItem {
  id: number
  message: string
  tone: "info" | "warning" | "error"
  durationMs: number
}

let seed = 0
const toasts = ref<ToastItem[]>([])

function pushToast(message: string, tone: ToastItem["tone"] = "info", durationMs = 3000) {
  const id = ++seed
  toasts.value.push({ id, message, tone, durationMs })
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs)
  }
}

function dismissToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function useToast() {
  return { toasts, pushToast, dismissToast }
}
