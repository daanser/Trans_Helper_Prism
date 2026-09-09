// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 审计日志单测（tasks.md T3.3）
// 全 mock：D1 记录 SQL + bind 参数；零网络。
// 重点：① 写入字段完整；② detail 截断 200 字；③ 密钥形状被抹除（断言里只用明显假的占位串）；
//       ④ 缺 D1 / SQL 异常一律静默返回 false，绝不抛错、绝不阻断主流程。
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  AUDIT_ACTION_MAX,
  AUDIT_DETAIL_MAX,
  AUDIT_TARGET_MAX,
  redactSecrets,
  sanitizeAuditDetail,
  sanitizeAuditText,
  writeAudit,
  listAudit,
  type AuditRow,
} from "../src/audit"

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0)
/** 明显假的占位 key（绝不是真实 key）：用于断言「不得落库」。 */
const FAKE_KEY = "sk-fake0000000000000000"
const FAKE_BEARER = "faketoken000000000000"

/** 记录 SQL + bind 参数的 D1 mock。 */
function makeDb(opts: { fail?: boolean; rows?: AuditRow[] } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(rec)
          return stmt
        },
        async run() {
          if (opts.fail) throw new Error("d1-write-failed")
          return { success: true, results: [], meta: { changes: 1 } }
        },
        async all() {
          if (opts.fail) throw new Error("d1-read-failed")
          return { success: true, meta: { changes: 0 }, results: opts.rows ?? [] }
        },
      }
      return stmt
    },
  } as unknown as D1Database
  return { db, calls }
}

describe("redactSecrets / sanitizeAuditText", () => {
  it("抹掉 sk- / Bearer / key=… 形状", () => {
    expect(redactSecrets(`rotated ${FAKE_KEY} ok`)).not.toContain(FAKE_KEY)
    expect(redactSecrets(`Authorization: Bearer ${FAKE_BEARER}`)).not.toContain(FAKE_BEARER)
    expect(redactSecrets("api_key=abcdef123456")).toBe("api_key=[redacted]")
    expect(redactSecrets("token: abcdef123456")).toBe("token: [redacted]")
    expect(redactSecrets("password=hunter2")).toBe("password=[redacted]")
    // 普通文本不受影响
    expect(redactSecrets("reason=abuse-frequency delta=+3600s")).toBe("reason=abuse-frequency delta=+3600s")
  })

  it("空白折叠成单行 + 去首尾", () => {
    expect(sanitizeAuditText("  a\n\n  b\t c  ", 200)).toBe("a b c")
  })

  it("超长截断到 max 字；非字符串/负数上限 → 空串", () => {
    expect(sanitizeAuditText("x".repeat(500), AUDIT_DETAIL_MAX)).toHaveLength(AUDIT_DETAIL_MAX)
    expect(sanitizeAuditText(undefined, 200)).toBe("")
    expect(sanitizeAuditText({} as unknown, 200)).toBe("")
    expect(sanitizeAuditText("abc", 0)).toBe("")
    expect(sanitizeAuditDetail("y".repeat(500))).toHaveLength(200)
  })
})

describe("writeAudit", () => {
  it("写入完整字段（id/actor/action/target/detail/created_at）", async () => {
    const { db, calls } = makeDb()
    const ok = await writeAudit(db, {
      actorId: "admin-1",
      action: "ban",
      target: "acc-9",
      detail: "reason=abuse-frequency",
      nowMs: NOW,
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    const { sql, args } = calls[0]
    expect(sql).toContain("INSERT INTO audit_log")
    expect(sql).toContain("(id, actor_id, action, target, detail, created_at)")
    expect(args[0]).toMatch(/^[0-9a-f-]{36}$/) // randomUUID
    expect(args.slice(1)).toEqual(["admin-1", "ban", "acc-9", "reason=abuse-frequency", NOW])
  })

  it("actorId 空 → 落 'system'（schema NOT NULL）", async () => {
    const { db, calls } = makeDb()
    await writeAudit(db, { actorId: "", action: "grant_quota", target: "acc-9" })
    expect(calls[0].args[1]).toBe("system")
  })

  it("detail 超 200 字被截断，且空白折叠", async () => {
    const { db, calls } = makeDb()
    await writeAudit(db, { actorId: "admin-1", action: "set_model", detail: `${"z".repeat(300)}\n\n end` })
    const detail = String(calls[0].args[4])
    expect(detail).toHaveLength(AUDIT_DETAIL_MAX)
    expect(detail).not.toContain("\n")
  })

  it("detail 里的 key 形状被抹除（绝不落库明文）", async () => {
    const { db, calls } = makeDb()
    await writeAudit(db, {
      actorId: "admin-1",
      action: "key_disable",
      target: "llm-key-3",
      detail: `upstream 401 with ${FAKE_KEY} and Bearer ${FAKE_BEARER}`,
      nowMs: NOW,
    })
    const flat = calls[0].args.map((a) => String(a)).join("|")
    expect(flat).not.toContain(FAKE_KEY)
    expect(flat).not.toContain(FAKE_BEARER)
    expect(flat).toContain("[redacted]")
  })

  it("target/action 也做截断（防超长/注入式脏数据）", async () => {
    const { db, calls } = makeDb()
    await writeAudit(db, { actorId: "admin-1", action: "a".repeat(200), target: "t".repeat(500) })
    expect(String(calls[0].args[2])).toHaveLength(AUDIT_ACTION_MAX)
    expect(String(calls[0].args[3])).toHaveLength(AUDIT_TARGET_MAX)
  })

  it("action 为空 → 不写库，返回 false（不抛错）", async () => {
    const { db, calls } = makeDb()
    expect(await writeAudit(db, { actorId: "admin-1", action: "   " })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("缺 D1 → false（静默跳过，不抛错）", async () => {
    expect(await writeAudit(undefined, { actorId: "admin-1", action: "ban" })).toBe(false)
    expect(await writeAudit(null, { actorId: "admin-1", action: "ban" })).toBe(false)
  })

  it("D1 抛错 → false + 泛化 warning（不含 detail/参数）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { db } = makeDb({ fail: true })
    const ok = await writeAudit(db, {
      actorId: "admin-1",
      action: "ban",
      target: "acc-9",
      detail: `secret ${FAKE_KEY}`,
    })
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = String(warn.mock.calls[0][0])
    expect(logged).toContain("action=ban")
    expect(logged).not.toContain(FAKE_KEY)
    expect(logged).not.toContain("acc-9")
  })
})

describe("listAudit", () => {
  const rows: AuditRow[] = [
    { id: "b", actor_id: "admin-1", action: "ban", target: "acc-9", detail: "", created_at: NOW },
    { id: "a", actor_id: "admin-1", action: "grant_quota", target: "acc-8", detail: "delta=+3600s", created_at: NOW - 1 },
  ]

  it("按时间倒序查询，limit/offset 绑定参数", async () => {
    const { db, calls } = makeDb({ rows })
    const out = await listAudit(db, { limit: 10, offset: 20 })
    expect(out).toEqual(rows)
    const { sql, args } = calls[0]
    expect(sql).toContain("FROM audit_log")
    expect(sql).toContain("ORDER BY created_at DESC")
    expect(args).toEqual([10, 20])
  })

  it("默认 limit=50 / offset=0；越界值被夹紧", async () => {
    const { db, calls } = makeDb({ rows: [] })
    await listAudit(db)
    expect(calls[0].args).toEqual([50, 0])

    await listAudit(db, { limit: 100000, offset: -5 })
    expect(calls[1].args).toEqual([200, 0])

    await listAudit(db, { limit: 0, offset: 3.7 })
    expect(calls[2].args).toEqual([1, 3])
  })

  it("缺 D1 → []（不抛错）", async () => {
    expect(await listAudit(undefined)).toEqual([])
    expect(await listAudit(null, { limit: 5 })).toEqual([])
  })

  it("D1 抛错 → [] + 泛化 warning（不抛错）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { db } = makeDb({ fail: true })
    expect(await listAudit(db)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[audit] list failed")
  })
})
