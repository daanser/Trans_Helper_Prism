// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 测试用 D1 mock 的 `batch()` 补丁（性能优化：D1 往返压缩）
//
// 背景：`ratecount.consumeRateToken` / `quota.ensureWindow` / `quota.chargeQuota` 现在用
// `db.batch([...])` 把原本 2~3 次顺序往返压成 1 次。仓库里各测试的内存 D1 mock 都只实现了
// `prepare()`，因此需要一个**通用**补丁：让每条语句按其自身的 `first()` / `run()` 语义在批内执行，
// 并把结果包成 `D1Result` 形状按序返回（与真实 D1 的 batch 契约一致）。
//
// 用法（在 mock 工厂的返回处包一层）：
// ```ts
// const db = withBatch({ prepare(sql) { ... } }) as unknown as D1Database
// ```
// 注意：本文件不是测试文件（vitest 的 include 是 `tests/**/*.test.ts`），只被其他测试 import。

/** 语句对象的最小形状（各 mock 自己实现 run/first；这里只借用它们）。 */
interface MockStmt {
  run?: () => Promise<unknown>
  first?: () => Promise<unknown>
  bind?: (...args: unknown[]) => unknown
  [k: string]: unknown
}

/**
 * 给 mock 的 D1 补上 `batch()`：
 *   · 按语句顺序串行执行（真实 D1 的 batch 也是按序执行、隐式事务）；
 *   · SELECT（按 SQL 文本判断）→ 用 `first()` 取一行包成 `results: [row]`；
 *   · 其余 → 用 `run()` 的原返回值（各 mock 已返回 `{ success, results, meta: { changes } }`）；
 *   · 保留 mock 的异常传播：批内任一语句抛错 → 整个 batch reject（真实 D1 是隐式事务，整批失败）。
 */
export function withBatch<T extends { prepare: (sql: string) => unknown }>(db: T): T & {
  batch: (stmts: unknown[]) => Promise<unknown[]>
} {
  const originalPrepare = db.prepare.bind(db)

  const tag = (stmt: unknown, sql: string): unknown => {
    const s = stmt as MockStmt | null
    if (!s || typeof s !== "object" || typeof s.__batchExec === "function") return stmt
    Object.defineProperty(s, "__batchExec", {
      value: async () => {
        if (/^\s*select/i.test(sql)) {
          const row = typeof s.first === "function" ? await s.first() : null
          return { success: true, results: row === null || row === undefined ? [] : [row], meta: { changes: 0 } }
        }
        if (typeof s.run === "function") return await s.run()
        return { success: true, results: [], meta: { changes: 0 } }
      },
      enumerable: false,
    })
    return stmt
  }

  const patched = {
    ...db,
    prepare(sql: string) {
      const stmt = tag(originalPrepare(sql), sql)
      const s = stmt as MockStmt
      if (typeof s.bind === "function") {
        const originalBind = s.bind.bind(s)
        s.bind = (...args: unknown[]) => tag(originalBind(...args), sql)
      }
      return stmt
    },
    async batch(stmts: unknown[]) {
      const out: unknown[] = []
      for (const s of stmts) {
        const exec = (s as MockStmt | null)?.__batchExec
        if (typeof exec !== "function") throw new Error("withBatch: statement not created by this mock's prepare()")
        out.push(await exec())
      }
      return out
    },
  }
  return patched as T & { batch: (stmts: unknown[]) => Promise<unknown[]> }
}
