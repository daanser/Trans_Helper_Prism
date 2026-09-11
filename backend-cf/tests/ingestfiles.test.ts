// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — "零 chunk 文件集合"单测（技术债 #5）
// 全 mock：内存 D1 假表实现 ingest_files 的 upsert/delete/select 语义，零网络。
// 重点：① 校验与批量语义（登记/移除/单条非法只跳过/上限截断）；
//       ② upsert 只改 blob_sha（**不动 content_hash**，Worker 侧摄取不受影响）；
//       ③ 集合只含 blob_sha 非空的行（有 payload 的文件行为不变）；
//       ④ 路由：鉴权、422、503、GET/POST 形状；
//       ⑤ Actions 侧接线（workflow 文本 + 脚本契约）不漂移。
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  DROP_BATCH_SIZE,
  MAX_INGEST_FILES_LIST,
  MAX_INGEST_FILES_PER_REQUEST,
  UPSERT_ZERO_CHUNK_SQL,
  applyIngestFilesPlan,
  isValidPath,
  shouldProcessFile,
  listZeroChunkFiles,
  parseIngestFilesInput,
} from "../src/ingestfiles"
import { app } from "../src/index"
import type { Env } from "../src/types"

const SHA_A = "a".repeat(40) // git blob sha（sha1 = 40 hex）
const SHA_B = "b".repeat(40)

interface FileRow {
  wiki_id: string
  path: string
  content_hash: string
  blob_sha: string | null
  updated_at: number
}

/** 内存 D1：只实现 ingest_files 的三条语句形状（认不出就抛错，防实现漂移）。 */
function makeDb(failOn?: string) {
  const rows = new Map<string, FileRow>()
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const key = (w: string, p: string) => `${w}\u0000${p}`

  const apply = (sql: string, args: unknown[]): number => {
    if (sql.includes("INSERT INTO ingest_files")) {
      const [wiki, path, sha, updatedAt] = args as [string, string, string, number]
      const k = key(wiki, path)
      const cur = rows.get(k)
      if (cur) {
        // ON CONFLICT DO UPDATE：只改 blob_sha/updated_at（content_hash 原样保留）
        cur.blob_sha = sha
        cur.updated_at = updatedAt
        return 1
      }
      rows.set(k, { wiki_id: wiki, path, content_hash: "", blob_sha: sha, updated_at: updatedAt })
      return 1
    }
    if (sql.startsWith("DELETE FROM ingest_files WHERE wiki_id = ? AND path IN")) {
      const [wiki, ...paths] = args as string[]
      let n = 0
      for (const p of paths) if (rows.delete(key(wiki, p))) n++
      return n
    }
    throw new Error(`unhandled-sql: ${sql}`)
  }

  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(rec)
          return stmt
        },
        async first() {
          if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
          return null
        },
        async all<T>() {
          if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
          if (!sql.includes("FROM ingest_files")) return { results: [] as T[] }
          const [wiki, limit] = rec.args as [string, number]
          const mine = [...rows.values()]
            .filter((r) => r.wiki_id === wiki && r.blob_sha !== null && r.blob_sha !== "")
            .sort((a, b) => (a.path < b.path ? -1 : 1))
            .slice(0, limit)
          return { results: mine.map((r) => ({ path: r.path, blob_sha: r.blob_sha })) as T[] }
        },
        async run() {
          if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
          return { success: true, results: [], meta: { changes: apply(sql, rec.args) } }
        },
      }
      return stmt
    },
  } as unknown as D1Database
  return { db, rows, calls }
}

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: undefined as never, SEARCH_CACHE: undefined as never, INGEST_QUEUE: undefined as never, ...over } as unknown as Env
}

/** 预置一行（模拟 Worker 侧摄取写的行：有 content_hash、没有 blob_sha）。 */
function seedWorkerRow(m: ReturnType<typeof makeDb>, wiki: string, path: string, hash: string) {
  m.rows.set(`${wiki}\u0000${path}`, { wiki_id: wiki, path, content_hash: hash, blob_sha: null, updated_at: 1 })
}

describe("parseIngestFilesInput：校验与批量语义", () => {
  it("wiki_id 必填；zero_chunk/drop 必须是数组", () => {
    expect(parseIngestFilesInput({})).toEqual({ ok: false, error: "wiki_id-required" })
    expect(parseIngestFilesInput({ wiki_id: "   " })).toEqual({ ok: false, error: "wiki_id-required" })
    expect(parseIngestFilesInput({ wiki_id: "x".repeat(65) })).toEqual({ ok: false, error: "wiki_id-too-long" })
    expect(parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: "nope" })).toEqual({ ok: false, error: "invalid-body" })
    expect(parseIngestFilesInput({ wiki_id: "mtf-wiki", drop: {} })).toEqual({ ok: false, error: "invalid-body" })
    expect(parseIngestFilesInput(null)).toEqual({ ok: false, error: "invalid-body" })
    expect(parseIngestFilesInput([])).toEqual({ ok: false, error: "invalid-body" })
  })

  it("正常路径：登记 + 移除，path 去空白、sha 小写归一", () => {
    const r = parseIngestFilesInput({
      wiki_id: " rle-wiki ",
      zero_chunk: [{ path: " content/zh-cn/a.md ", blob_sha: SHA_A.toUpperCase() }],
      drop: [" content/zh-cn/b.md "],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan).toEqual({
      wiki_id: "rle-wiki",
      zero_chunk: [{ path: "content/zh-cn/a.md", blob_sha: SHA_A }],
      drop: ["content/zh-cn/b.md"],
      skipped: 0,
      truncated: false,
    })
  })

  it("单条非法只跳过并计数（不整批 422）：坏 sha / 空 path / 非对象 / 控制字符", () => {
    const r = parseIngestFilesInput({
      wiki_id: "mtf-wiki",
      zero_chunk: [
        { path: "ok.md", blob_sha: SHA_A },
        { path: "bad-sha.md", blob_sha: "not-a-sha" },
        { path: "", blob_sha: SHA_B },
        "not-an-object",
        { path: "ctrl\u0000.md", blob_sha: SHA_B },
      ],
      drop: ["", 42, "fine.md"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.zero_chunk).toEqual([{ path: "ok.md", blob_sha: SHA_A }])
    expect(r.plan.drop).toEqual(["fine.md"])
    expect(r.plan.skipped).toBe(6) // zero_chunk 4 条非法（坏 sha / 空 path / 非对象 / 控制字符）+ drop 2 条（空串 / 数字）
  })

  it("同一 path 既登记又移除 → 以登记为准（不让一次请求自相矛盾）", () => {
    const r = parseIngestFilesInput({
      wiki_id: "mtf-wiki",
      zero_chunk: [{ path: "a.md", blob_sha: SHA_A }],
      drop: ["a.md", "a.md", "b.md"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.zero_chunk.map((f) => f.path)).toEqual(["a.md"])
    expect(r.plan.drop).toEqual(["b.md"]) // 去重 + 排除已登记项
  })

  it("重复登记同一 path 只保留第一条", () => {
    const r = parseIngestFilesInput({
      wiki_id: "mtf-wiki",
      zero_chunk: [
        { path: "a.md", blob_sha: SHA_A },
        { path: "a.md", blob_sha: SHA_B },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.zero_chunk).toEqual([{ path: "a.md", blob_sha: SHA_A }])
  })

  it("超出单次上限 → 截断并标记 truncated（不是 422）", () => {
    const many = Array.from({ length: MAX_INGEST_FILES_PER_REQUEST + 10 }, (_, i) => ({
      path: `f${i}.md`,
      blob_sha: SHA_A,
    }))
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: many, drop: ["extra.md"] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.zero_chunk).toHaveLength(MAX_INGEST_FILES_PER_REQUEST)
    expect(r.plan.drop).toHaveLength(0) // 预算已被 zero_chunk 用光
    expect(r.plan.truncated).toBe(true)
  })

  it("isValidPath：长度与控制字符", () => {
    expect(isValidPath("content/zh-cn/a.md")).toBe(true)
    expect(isValidPath("")).toBe(false)
    expect(isValidPath("a".repeat(512))).toBe(true)
    expect(isValidPath("a".repeat(513))).toBe(false)
    expect(isValidPath("a\nb")).toBe(false)
    expect(isValidPath("a\u007fb")).toBe(false)
  })
})

describe("applyIngestFilesPlan：只写 blob_sha，不动 content_hash", () => {
  it("upsert 用 ON CONFLICT DO UPDATE（不是 INSERT OR REPLACE）", () => {
    expect(UPSERT_ZERO_CHUNK_SQL).toContain("ON CONFLICT(wiki_id, path) DO UPDATE SET blob_sha = excluded.blob_sha")
    expect(UPSERT_ZERO_CHUNK_SQL).not.toContain("INSERT OR REPLACE")
    expect(UPSERT_ZERO_CHUNK_SQL).toContain("content_hash") // 新行仍要给 NOT NULL 的 content_hash 一个值（''）
  })

  it("Worker 侧已写的行：登记零 chunk 后 content_hash 原样保留", async () => {
    const m = makeDb()
    seedWorkerRow(m, "mtf-wiki", "content/zh-cn/a.md", "sha1-of-content")
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: [{ path: "content/zh-cn/a.md", blob_sha: SHA_A }] })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(m.db, r.plan, 1234)
    const row = m.rows.get("mtf-wiki\u0000content/zh-cn/a.md")!
    expect(row.blob_sha).toBe(SHA_A)
    expect(row.content_hash).toBe("sha1-of-content") // 关键：没被 REPLACE 抹掉
    expect(row.updated_at).toBe(1234)
  })

  it("新行：content_hash 落空串（Worker 侧下次跑会自愈写真值）", async () => {
    const m = makeDb()
    const r = parseIngestFilesInput({ wiki_id: "rle-wiki", zero_chunk: [{ path: "content/zh-cn/short.md", blob_sha: SHA_A }] })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(m.db, r.plan, 7)
    expect(m.rows.get("rle-wiki\u0000content/zh-cn/short.md")).toEqual({
      wiki_id: "rle-wiki",
      path: "content/zh-cn/short.md",
      content_hash: "",
      blob_sha: SHA_A,
      updated_at: 7,
    })
  })

  it("drop 走一条 IN(...) 的 DELETE（批量，不 N 次往返）", async () => {
    const m = makeDb()
    seedWorkerRow(m, "mtf-wiki", "a.md", "h")
    seedWorkerRow(m, "mtf-wiki", "b.md", "h")
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", drop: ["a.md", "b.md"] })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(m.db, r.plan, 1)
    const deletes = m.calls.filter((c) => c.sql.startsWith("DELETE FROM ingest_files"))
    expect(deletes).toHaveLength(1)
    expect(deletes[0].args).toEqual(["mtf-wiki", "a.md", "b.md"])
    expect(m.rows.size).toBe(0)
  })

  it("drop 超过单条语句上限时自动分批（DROP_BATCH_SIZE）", async () => {
    const { db, calls } = makeDb()
    const paths = Array.from({ length: DROP_BATCH_SIZE + 5 }, (_, i) => `f${i}.md`)
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", drop: paths })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(db, r.plan, 1)
    const deletes = calls.filter((c) => c.sql.startsWith("DELETE FROM ingest_files"))
    expect(deletes).toHaveLength(2)
    expect((deletes[0].args as unknown[]).length).toBe(1 + DROP_BATCH_SIZE)
    expect((deletes[1].args as unknown[]).length).toBe(1 + 5)
  })

  it("空计划不发任何语句", async () => {
    const { db, calls } = makeDb()
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki" })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(db, r.plan, 1)
    expect(calls).toHaveLength(0)
  })

  it("D1 异常向上抛（路由回 503，Actions 侧软失败）", async () => {
    const { db } = makeDb("INSERT INTO ingest_files")
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] })
    if (!r.ok) throw new Error("parse failed")
    await expect(applyIngestFilesPlan(db, r.plan, 1)).rejects.toThrow("d1-failed")
  })
})

describe("listZeroChunkFiles：集合只含 blob_sha 非空的行", () => {
  it("Worker 侧的行（只有 content_hash）不出现在集合里", async () => {
    const m = makeDb()
    seedWorkerRow(m, "mtf-wiki", "content/zh-cn/really-short.md", "sha1-x")
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: [{ path: "content/zh-cn/empty.md", blob_sha: SHA_A }] })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(m.db, r.plan, 1)

    const { files } = await listZeroChunkFiles(m.db, "mtf-wiki")
    expect(files).toEqual([{ path: "content/zh-cn/empty.md", blob_sha: SHA_A }])
  })

  it("按 path 升序、只取本 wiki；空集合 → []", async () => {
    const { db } = makeDb()
    const r = parseIngestFilesInput({
      wiki_id: "mtf-wiki",
      zero_chunk: [
        { path: "z.md", blob_sha: SHA_A },
        { path: "a.md", blob_sha: SHA_B },
      ],
    })
    const other = parseIngestFilesInput({ wiki_id: "rle-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] })
    if (!r.ok || !other.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(db, r.plan, 1)
    await applyIngestFilesPlan(db, other.plan, 1)

    expect((await listZeroChunkFiles(db, "mtf-wiki")).files.map((f) => f.path)).toEqual(["a.md", "z.md"])
    expect((await listZeroChunkFiles(db, "ftm-wiki")).files).toEqual([])
  })

  it("超过上限 → 截断并标记 truncated", async () => {
    const { db } = makeDb()
    const many = Array.from({ length: 4 }, (_, i) => ({ path: `f${i}.md`, blob_sha: SHA_A }))
    const r = parseIngestFilesInput({ wiki_id: "mtf-wiki", zero_chunk: many })
    if (!r.ok) throw new Error("parse failed")
    await applyIngestFilesPlan(db, r.plan, 1)
    const limited = await listZeroChunkFiles(db, "mtf-wiki", 2)
    expect(limited.files).toHaveLength(2)
    expect(limited.truncated).toBe(true)
    const all = await listZeroChunkFiles(db, "mtf-wiki")
    expect(all.files).toHaveLength(4)
    expect(all.truncated).toBe(false)
    expect(MAX_INGEST_FILES_LIST).toBeGreaterThan(4)
  })
})

describe("路由 GET/POST /api/v1/admin/ingest/files", () => {
  const adminEnv = (db: D1Database | undefined) => makeEnv({ DB: db as never, ADMIN_API_KEY: "admin-secret" })
  const auth = { Authorization: "Bearer admin-secret", "Content-Type": "application/json" }

  it("无鉴权 → 401；未配 DB → 503", async () => {
    const { db } = makeDb()
    expect((await app.request("/api/v1/admin/ingest/files?wiki_id=mtf-wiki", {}, adminEnv(db))).status).toBe(401)
    expect(
      (await app.request("/api/v1/admin/ingest/files?wiki_id=mtf-wiki", { headers: auth }, adminEnv(undefined))).status,
    ).toBe(503)
  })

  it("GET 缺 wiki_id → 422；正常 → 返回集合", async () => {
    const { db } = makeDb()
    const env = adminEnv(db)
    expect((await app.request("/api/v1/admin/ingest/files", { headers: auth }, env)).status).toBe(422)
    const post = await app.request(
      "/api/v1/admin/ingest/files",
      { method: "POST", headers: auth, body: JSON.stringify({ wiki_id: "rle-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] }) },
      env,
    )
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ ok: true, wiki_id: "rle-wiki", zero_chunk: 1, dropped: 0, skipped: 0, truncated: false })

    const get = await app.request("/api/v1/admin/ingest/files?wiki_id=rle-wiki", { headers: auth }, env)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({
      ok: true,
      wiki_id: "rle-wiki",
      files: [{ path: "a.md", blob_sha: SHA_A }],
      count: 1,
      truncated: false,
    })
  })

  it("POST 非法 body / 非法 status 形状 → 422，且不落库", async () => {
    const { db, rows } = makeDb()
    const env = adminEnv(db)
    expect((await app.request("/api/v1/admin/ingest/files", { method: "POST", headers: auth, body: "{" }, env)).status).toBe(422)
    expect(
      (await app.request("/api/v1/admin/ingest/files", { method: "POST", headers: auth, body: JSON.stringify({}) }, env)).status,
    ).toBe(422)
    expect(rows.size).toBe(0)
  })

  it("POST drop → 从集合移除（模拟「文件本轮产出了 chunk」）", async () => {
    const { db } = makeDb()
    const env = adminEnv(db)
    await app.request(
      "/api/v1/admin/ingest/files",
      { method: "POST", headers: auth, body: JSON.stringify({ wiki_id: "rle-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] }) },
      env,
    )
    const drop = await app.request(
      "/api/v1/admin/ingest/files",
      { method: "POST", headers: auth, body: JSON.stringify({ wiki_id: "rle-wiki", drop: ["a.md"] }) },
      env,
    )
    expect(await drop.json()).toMatchObject({ dropped: 1, zero_chunk: 0 })
    const get = await app.request("/api/v1/admin/ingest/files?wiki_id=rle-wiki", { headers: auth }, env)
    expect(((await get.json()) as { count: number }).count).toBe(0)
  })

  it("D1 异常 → 503（不是 500，也不回显 SQL）", async () => {
    const { db } = makeDb("INSERT INTO ingest_files")
    const env = adminEnv(db)
    const resp = await app.request(
      "/api/v1/admin/ingest/files",
      { method: "POST", headers: auth, body: JSON.stringify({ wiki_id: "rle-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] }) },
      env,
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "db-unavailable" })
  })

  it("响应绝不回显密钥（只回 path/sha/计数）", async () => {
    const { db } = makeDb()
    const env = adminEnv(db)
    const resp = await app.request(
      "/api/v1/admin/ingest/files",
      { method: "POST", headers: auth, body: JSON.stringify({ wiki_id: "rle-wiki", zero_chunk: [{ path: "a.md", blob_sha: SHA_A }] }) },
      env,
    )
    const raw = JSON.stringify(await resp.json())
    expect(raw).not.toContain("admin-secret")
    expect(raw).not.toContain("Bearer")
  })
})

describe("shouldProcessFile：增量判据（唯一实现）", () => {
  const TREE = SHA_A
  const OLD = SHA_B

  it("--full → 一律处理（绕过所有判据）", () => {
    expect(shouldProcessFile({ full: true, treeSha: TREE, payloadSha: TREE, zeroChunkSha: TREE })).toBe(true)
  })

  it("有 payload：sha 相同 → 跳过；sha 不同 → 处理（**主判据，行为不变**）", () => {
    expect(shouldProcessFile({ treeSha: TREE, payloadSha: TREE })).toBe(false)
    expect(shouldProcessFile({ treeSha: TREE, payloadSha: OLD })).toBe(true)
    // 老数据没有 blob_sha（payloadSha undefined）→ 照旧当作"变了"处理一次
    expect(shouldProcessFile({ treeSha: TREE, payloadSha: undefined })).toBe(true)
  })

  it("无 payload 的极短文件：在零 chunk 集合里且 sha 相同 → 跳过（技术债 #5 的核心）", () => {
    expect(shouldProcessFile({ treeSha: TREE, zeroChunkSha: TREE })).toBe(false)
    expect(shouldProcessFile({ treeSha: TREE, zeroChunkSha: OLD })).toBe(true) // 内容变了 → 复核一次
    expect(shouldProcessFile({ treeSha: TREE })).toBe(true) // 不在集合里 → 照旧处理
  })

  it("有 payload 的文件**不受零 chunk 集合影响**（判据是逻辑与）", () => {
    // payload 相同、集合里也有 → 仍跳过（由主判据裁决）
    expect(shouldProcessFile({ treeSha: TREE, payloadSha: TREE, zeroChunkSha: OLD })).toBe(false)
    // payload 不同（文件从 0 chunk 变成有内容）→ 必须处理，集合里有旧 sha 也拦不住
    expect(shouldProcessFile({ treeSha: TREE, payloadSha: OLD, zeroChunkSha: OLD })).toBe(true)
  })
})

describe("两轮增量模拟（技术债 #5 的验收条件）", () => {
  /** 一轮增量的判定：返回需要处理的 path（与脚本 runWiki 同样的顺序）。 */
  const round = (
    tree: Array<{ path: string; sha: string }>,
    payloadShas: Map<string, string>,
    zeroChunk: Map<string, string>,
    full = false,
  ) =>
    tree
      .filter((e) => shouldProcessFile({ full, treeSha: e.sha, payloadSha: payloadShas.get(e.path), zeroChunkSha: zeroChunk.get(e.path) }))
      .map((e) => e.path)

  /** 一轮结束后回写集合（0 chunk → 登记 / 有 chunk → 移除）。 */
  async function reportRound(
    db: D1Database,
    wiki: string,
    processed: Array<{ path: string; sha: string; chunks: number }>,
  ) {
    const zero_chunk = processed.filter((p) => p.chunks === 0).map((p) => ({ path: p.path, blob_sha: p.sha }))
    const drop = processed.filter((p) => p.chunks > 0).map((p) => p.path)
    const plan = { wiki_id: wiki, zero_chunk, drop, skipped: 0, truncated: false }
    await applyIngestFilesPlan(db, plan, 1)
  }
  const asMap = (files: Array<{ path: string; blob_sha: string }>) => new Map(files.map((f) => [f.path, f.blob_sha]))

  // 线上实测的那三个 wiki：极短文件解析后 0 chunk（rle-wiki changed=3 points=0）
  const TREE = [
    { path: "content/_index.md", sha: "1".repeat(40) }, // 目录元数据，永远 0 chunk
    { path: "content/a.md", sha: SHA_A },
    { path: "content/b.md", sha: SHA_B },
    { path: "content/substantial.md", sha: "c".repeat(40) },
  ]

  it("第一轮：4 个文件都要处理（集合为空）；0 chunk 的登记进集合，有 chunk 的不登记", async () => {
    const { db } = makeDb()
    const payload = new Map<string, string>() // Qdrant 里还没有任何 point
    const zero = asMap((await listZeroChunkFiles(db, "rle-wiki")).files)

    const need = round(TREE, payload, zero)
    expect(need).toEqual(TREE.map((e) => e.path)) // 全都要处理（今天的空转行为）

    await reportRound(db, "rle-wiki", [
      { path: "content/_index.md", sha: TREE[0].sha, chunks: 0 },
      { path: "content/a.md", sha: SHA_A, chunks: 0 },
      { path: "content/b.md", sha: SHA_B, chunks: 0 },
      { path: "content/substantial.md", sha: TREE[3].sha, chunks: 5 },
    ])

    const after = await listZeroChunkFiles(db, "rle-wiki")
    expect(after.files.map((f) => f.path)).toEqual(["content/_index.md", "content/a.md", "content/b.md"])
    // 有 chunk 的文件不入集合：它由 Qdrant payload.blob_sha 裁决
    expect(after.files.some((f) => f.path === "content/substantial.md")).toBe(false)
  })

  it("第二轮（无任何改动）→ **files=0**：只有 substantial 那条仍由 Qdrant 裁决，其余全部跳过", () => {
    // substantial.md 已入库（payload 有 blob_sha），三个 0 chunk 文件在集合里
    const payload = new Map<string, string>([["content/substantial.md", TREE[3].sha]])
    const zero = new Map<string, string>([
      ["content/_index.md", TREE[0].sha],
      ["content/a.md", SHA_A],
      ["content/b.md", SHA_B],
    ])
    expect(round(TREE, payload, zero)).toEqual([]) // ← 验收：changed=0
  })

  it("内容变了才复核：sha 变了的 0 chunk 文件重新处理一次并更新集合", async () => {
    const { db } = makeDb()
    // 集合先落库：三个 0 chunk 文件都在集合里，但 a.md 记的是旧 sha（= 内容变过）
    await applyIngestFilesPlan(
      db,
      {
        wiki_id: "rle-wiki",
        zero_chunk: [
          { path: "content/_index.md", blob_sha: TREE[0].sha },
          { path: "content/a.md", blob_sha: "9".repeat(40) },
          { path: "content/b.md", blob_sha: SHA_B },
        ],
        drop: [],
        skipped: 0,
        truncated: false,
      },
      1,
    )
    const payload = new Map<string, string>([["content/substantial.md", TREE[3].sha]])
    const zero = asMap((await listZeroChunkFiles(db, "rle-wiki")).files)
    expect(round(TREE, payload, zero)).toEqual(["content/a.md"]) // 只有它 sha 变了

    // 复核后仍是 0 chunk → 集合里的 sha 更新为新值（下一轮又跳过）
    await reportRound(db, "rle-wiki", [{ path: "content/a.md", sha: SHA_A, chunks: 0 }])
    const after = asMap((await listZeroChunkFiles(db, "rle-wiki")).files)
    expect(after.get("content/a.md")).toBe(SHA_A)
    expect(round(TREE, payload, after)).toEqual([])
  })

  it("0 chunk 文件长出内容 → 复核并产出 chunk → 从集合移除，之后由 Qdrant 裁决", async () => {
    const { db } = makeDb()
    const zero = new Map<string, string>([["content/a.md", SHA_A]])
    const newSha = "f".repeat(40)
    const tree = [{ path: "content/a.md", sha: newSha }]
    expect(round(tree, new Map(), zero)).toEqual(["content/a.md"]) // sha 变了 → 处理

    await reportRound(db, "rle-wiki", [{ path: "content/a.md", sha: newSha, chunks: 3 }])
    expect((await listZeroChunkFiles(db, "rle-wiki")).files).toEqual([]) // 已移出集合

    // 此后 payload 有 sha → 主判据裁决（未变即跳过）
    const payload = new Map<string, string>([["content/a.md", newSha]])
    expect(round(tree, payload, new Map())).toEqual([])
    // 内容再变 → 处理
    expect(round([{ path: "content/a.md", sha: "0".repeat(40) }], payload, new Map())).toEqual(["content/a.md"])
  })

  it("--full 与文件消失：full 一律处理；集合里已消失的 path 由 drop 清掉", async () => {
    const zero = new Map<string, string>([
      ["content/a.md", SHA_A],
      ["content/gone.md", "e".repeat(40)], // 文件已从仓库删除
    ])
    expect(round(TREE, new Map(), zero, true)).toEqual(TREE.map((e) => e.path)) // full
    // 脚本侧：stale = 集合里有、但 tree 里没有
    const mdSet = new Set(TREE.map((e) => e.path))
    const stale = [...zero.keys()].filter((p) => !mdSet.has(p))
    expect(stale).toEqual(["content/gone.md"])

    const { db } = makeDb()
    await reportRound(db, "rle-wiki", []) // 空报告
    const plan = { wiki_id: "rle-wiki", zero_chunk: [], drop: stale, skipped: 0, truncated: false }
    await applyIngestFilesPlan(db, plan, 1)
    expect((await listZeroChunkFiles(db, "rle-wiki")).files).toEqual([])
  })
})

describe("Actions 侧接线（workflow + 脚本契约不漂移）", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ingest.yml", import.meta.url), "utf8")
  const script = readFileSync(new URL("../scripts/ingest-incremental.ts", import.meta.url), "utf8")

  it("workflow 把 ADMIN_API_KEY / API_BASE 传给摄取步骤（否则脚本会退化成照旧复核）", () => {
    expect(workflow).toContain("ADMIN_API_KEY: ${{ secrets.ADMIN_API_KEY }}")
    expect(workflow).toContain("API_BASE: https://transhelper-prism-backend.transprism.workers.dev")
    expect(workflow).toContain("INGEST_SUMMARY_PATH")
  })

  it("脚本用同一对端点，且取/报都软失败（只警告，不抛）", () => {
    expect(script).toContain("/api/v1/admin/ingest/files?wiki_id=")
    expect(script).toContain("`${API_BASE}/api/v1/admin/ingest/files`")
    // 取/报异常路径必须是 console.warn（不能 throw 影响摄取）
    expect(script).toMatch(/取零 chunk 集合异常（不影响摄取）/)
    expect(script).toMatch(/回报零 chunk 集合异常（不影响摄取）/)
    expect(script).toContain("ZERO_CHUNK_ENABLED")
  })

  it("脚本复用 src/ingestfiles.ts 的 shouldProcessFile（判据只有一处实现）", () => {
    expect(script).toContain("shouldProcessFile({ full: FULL, treeSha: e.sha")
    expect(script).toContain('from "../src/ingestfiles"')
  })
})
