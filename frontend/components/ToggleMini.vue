<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — ToggleMini: 清晰可靠的自适应微型开关 -->
<template>
  <label class="group inline-flex cursor-pointer select-none items-center gap-2">
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :aria-label="label"
      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/30"
      :class="
        modelValue
          ? 'border-blue-600 bg-blue-600 dark:border-blue-500 dark:bg-blue-500'
          : 'border-slate-300 bg-slate-200 dark:border-slate-600 dark:bg-slate-700'
      "
      @click="toggle"
    >
      <span
        class="pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ease-in-out"
        :class="modelValue ? 'translate-x-[18px]' : 'translate-x-[2px]'"
      />
    </button>
    <span
      :class="
        hideLabel
          ? 'sr-only'
          : ['text-xs font-medium transition-colors', modelValue ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400']
      "
    >
      {{ label }}
    </span>
  </label>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast"

const props = defineProps<{
  modelValue: boolean
  label: string
  hint?: string
  warn?: boolean
  /** 仅保留无障碍名称、不显示文字（用于旁边已有说明文案的场景） */
  hideLabel?: boolean
}>()

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void
}>()

const { pushToast } = useToast()

function toggle() {
  const next = !props.modelValue
  emit("update:modelValue", next)
  if (next && props.hint) {
    pushToast(props.hint, props.warn ? "warning" : "info")
  }
}
</script>
