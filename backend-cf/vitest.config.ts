// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — vitest 配置（跑在 Workers 外，纯逻辑单测）
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // keypool / embeddings 均为纯 TS 逻辑，无需 Workers 运行时
  },
})
