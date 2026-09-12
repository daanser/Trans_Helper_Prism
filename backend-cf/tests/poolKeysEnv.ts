// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 测试用：把一组 key 值摆成 `POOL_KEYS_<n>` 变量（2026-09-12 合并池重构）
//
// 背景（plan-keypool.md §2.1）：密钥只来自 `POOL_KEYS_0` / `POOL_KEYS_1` / ……（**动态前缀扫描**），
// 旧的按能力命名的池变量已彻底移除（本次不留兼容）。
// 测试里到处手写 `{ POOL_KEYS_0: a, POOL_KEYS_1: b }` 又啰嗦又容易与实现漂移，故集中到这里。
//
// 用法：`new KeyPool(poolKeysEnv(["sk-a", "sk-b"]), db)` → 对应 ref `pool-key-0` / `pool-key-1`。

/** 一组 key 值 → `{ POOL_KEYS_<start+i>: value }` 形状的 env 片段。 */
export function poolKeysEnv(secrets: string | readonly string[], startIndex = 0): Record<string, string> {
  const list = typeof secrets === "string" ? [secrets] : [...secrets]
  const out: Record<string, string> = {}
  list.forEach((value, i) => {
    out[`POOL_KEYS_${startIndex + i}`] = value
  })
  return out
}

/** 单个 key 值的 env（常用：`singlePoolKeyEnv("sk-a")` → `{POOL_KEYS_0:"sk-a"}`）。 */
export function singlePoolKeyEnv(secret: string): Record<string, string> {
  return poolKeysEnv([secret])
}

/** 把「逗号分隔的多把」塞进**一个**变量（测 `pool-key-0#2` 这种 ref 用）。 */
export function commaPoolKeyEnv(secrets: readonly string[], index = 0): Record<string, string> {
  return { [`POOL_KEYS_${index}`]: secrets.join(",") }
}
