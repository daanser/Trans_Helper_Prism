<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 接口状态徽章（管理页用）
     如实反映后端可用性：已接入 / 接口未实现（404/501）/ 加载失败 -->
<template>
  <span class="rounded px-1.5 py-0.5 text-[10px] font-medium" :class="toneClass">
    {{ label }}
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue"

export type LoadState = "idle" | "loading" | "ok" | "unimplemented" | "error"

const props = defineProps<{ state: LoadState }>()

const label = computed(() => {
  switch (props.state) {
    case "loading":
      return "加载中"
    case "ok":
      return "已接入"
    case "unimplemented":
      return "接口未实现"
    case "error":
      return "加载失败"
    default:
      return "待加载"
  }
})

const toneClass = computed(() => {
  switch (props.state) {
    case "ok":
      return "bg-primary-subtle text-primary"
    case "unimplemented":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
    case "error":
      return "bg-danger-subtle text-danger"
    default:
      return "bg-canvas-subtle text-ink-muted"
  }
})
</script>
