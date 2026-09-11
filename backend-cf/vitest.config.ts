// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — vitest 配置（跑在 Workers 外，纯逻辑单测）
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 有些用例用真实计时器模拟超时；并行跑时默认 5s 偶尔不够（曾出现 flake）。放宽到 20s。
    testTimeout: 20_000,
    // 每个测试文件跑一遍：清掉模块级缓存（keydeny 禁用集的进程内缓存等），避免用例顺序影响结果
    setupFiles: ["tests/setup.ts"],
    // keypool / embeddings 均为纯 TS 逻辑，无需 Workers 运行时
  },
})
