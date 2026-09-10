// SPDX-License-Identifier: GPL-3.0-or-later
// 校验 src/db/schemaStatements.ts 与 src/db/schema.sql 一致（防止两处漂移）。
// 改 schema.sql 后请重新生成 schemaStatements.ts（去注释 → 按 ; 切分 → 空白折叠）。
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { SCHEMA_STATEMENTS } from "../src/db/schemaStatements"

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
