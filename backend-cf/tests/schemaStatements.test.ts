// SPDX-License-Identifier: GPL-3.0-or-later
// 校验 src/db/schemaStatements.ts 与 src/db/schema.sql 一致（防止两处漂移）。
// 改 schema.sql 后请重新生成 schemaStatements.ts（去注释 → 按 ; 切分 → 空白折叠）。
// 另外校验 key_usage.account_id 的**历史表补列迁移**：它天然不幂等，故单独导出（SCHEMA_MIGRATIONS）
// 并用 isToleratedSchemaError() 明确「哪些报错其实代表已经是对的状态」。
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS, isToleratedSchemaError } from "../src/db/schemaStatements"

describe("schemaStatements 与 schema.sql 一致", () => {
  it("派生结果逐条一致", () => {
    const raw = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8")
    const parsed = raw
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
    expect([...SCHEMA_STATEMENTS]).toEqual(parsed)
  })

  it("全部语句幂等（IF NOT EXISTS），可重复执行", () => {
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0)
    for (const s of SCHEMA_STATEMENTS) {
      expect(s).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS/i)
    }
  })

  it("覆盖 M3 新表（audit_log / custom_models）", () => {
    const joined = SCHEMA_STATEMENTS.join("\n")
    expect(joined).toContain("audit_log")
    expect(joined).toContain("custom_models")
  })
})

describe("key_usage.account_id：新库建表 + 历史表补列迁移", () => {
  it("新建库的 CREATE TABLE 已带 account_id（NOT NULL DEFAULT ''）", () => {
    const create = SCHEMA_STATEMENTS.find((s) => s.includes("CREATE TABLE IF NOT EXISTS key_usage"))!
    expect(create).toContain("account_id TEXT NOT NULL DEFAULT ''")
    // 账号 + 时间的聚合索引也在建表清单里
    expect(SCHEMA_STATEMENTS).toContain(
      "CREATE INDEX IF NOT EXISTS idx_key_usage_account_created ON key_usage (account_id, created_at)",
    )
  })

  it("补列迁移单独导出（不混进 schema.sql 的派生结果），语义正确且可重复执行", () => {
    expect(SCHEMA_MIGRATIONS).toEqual([`ALTER TABLE key_usage ADD COLUMN account_id TEXT NOT NULL DEFAULT ''`])
    // 迁移语句**不在** schema.sql 派生清单里（否则"逐条一致"的含义会被污染）
    expect([...SCHEMA_STATEMENTS]).not.toContain(SCHEMA_MIGRATIONS[0])
    // 列可空性/默认值正确：历史行补列后 account_id=''（匿名归属），不会因 NOT NULL 失败
    const stmt = SCHEMA_MIGRATIONS[0]
    expect(stmt).toMatch(/^ALTER TABLE key_usage ADD COLUMN account_id TEXT NOT NULL DEFAULT ''$/)
  })

  it("容忍的报错：duplicate column name（任意语句）、ALTER 的 no such table", () => {
    const alter = SCHEMA_MIGRATIONS[0]
    // 已迁移过 / 新库建表时已带该列
    expect(isToleratedSchemaError(alter, "SQLITE_ERROR: duplicate column name: account_id")).toBe(true)
    expect(isToleratedSchemaError(alter, "D1_ERROR: duplicate column name: account_id")).toBe(true)
    // 全新库：表还没建，随后同一批的 CREATE TABLE 会带上该列
    expect(isToleratedSchemaError(alter, "SQLITE_ERROR: no such table: key_usage")).toBe(true)
  })

  it("不容忍真错误：语法错、缺列、非 ALTER 语句的 no such table", () => {
    const alter = SCHEMA_MIGRATIONS[0]
    expect(isToleratedSchemaError(alter, `SQLITE_ERROR: near ")": syntax error`)).toBe(false)
    expect(isToleratedSchemaError(alter, "SQLITE_ERROR: cannot add a NOT NULL column with default value NULL")).toBe(false)
    expect(isToleratedSchemaError(alter, "D1_ERROR: network connection lost")).toBe(false)
    expect(isToleratedSchemaError(alter, undefined)).toBe(false)
    // CREATE 语句报 no such table 是真错误（例如索引指向不存在的表），不能当成功
    const create = SCHEMA_STATEMENTS.find((s) => s.includes("idx_key_usage_account_created"))!
    expect(isToleratedSchemaError(create, "SQLITE_ERROR: no such table: key_usage")).toBe(false)
  })
})
