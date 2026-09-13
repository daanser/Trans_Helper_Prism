// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 模型展示名（用户反馈 2026-09-13）
//
// 背景：卡片里直接显示了**模型 id**（`deepseek-flash`），而用户期望看到对外名称（`DeepSeek V4.1 Flash`）。
// 原则：**对外展示用人类可读名，id 只作为 title 兜底**；未知模型退化为"去掉厂商前缀"而不是隐藏。

/** 已知模型的 id → 展示名（大小写不敏感；key 一律小写） */
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4.1 Flash（Vision 实验版）",
}

/**
 * 模型 id → 展示名。
 * · 命中别名表 → 用别名（如 `deepseek-flash` → `DeepSeek V4.1 Flash`）
 * · 形如 `Vendor/Model` → 去掉厂商前缀（`Qwen/Qwen3.5-4B` → `Qwen3.5-4B`）
 * · 其它 → 原样返回（**不隐藏信息**，避免"显示成空白/未知"更难排查）
 */
export function modelDisplayName(id: string | null | undefined): string {
  const raw = (id ?? "").trim()
  if (!raw) return ""
  const hit = MODEL_ALIASES[raw.toLowerCase()]
  if (hit) return hit
  const slash = raw.lastIndexOf("/")
  return slash >= 0 && slash < raw.length - 1 ? raw.slice(slash + 1) : raw
}
