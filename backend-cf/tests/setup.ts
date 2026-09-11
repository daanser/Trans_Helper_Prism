// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — vitest 全局 setup：清理**模块级缓存**，保证用例之间互不影响。
//
// 为什么需要：性能优化第二轮给热路径加了进程内缓存（`keydeny:<pool>` 禁用集，见
// `src/keyadmin.ts` 的 `readDeniedPoolsCached`）。这类状态活在模块作用域里，**在同一个测试文件内
// 会被后续用例继承** —— 例如"先禁用 key-0 → 断言用 key-1"的用例会把禁用集留在缓存里，
// 让后面"没有任何禁用"的用例看到脏数据（真实踩过：keyadmin.test.ts 的两条路由用例因此变红）。
//
// 约定：**任何模块级缓存/单例都要在这里的 beforeEach 里清掉**，别让用例顺序决定结果。
import { beforeEach } from "vitest"
import { resetDeniedPoolsCache } from "../src/keyadmin"

beforeEach(() => {
  resetDeniedPoolsCache()
})
