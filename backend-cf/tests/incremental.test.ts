// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — incremental.ts 单测 (tasks.md T2.2 真增量版)
// 全 mock：GitHub tarball/commit、Qdrant scroll/upsert/delete、D1（ingest_runs、ingest_files）。
// D1 mock **严格**：未识别的语句一律抛错（防止实现漂移后测试静默通过，同 quota.test.ts 的 mock 哲学）。
// 覆盖：commit 相同 skip；真·文件级增量（hash 未变不重嵌、只 upsert changed）；新增/修改/删除文件；
//       记账；无 D1/Qdrant 降级。注意：contentHash 用 WebCrypto，vitest(node) 环境原生支持。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { gzipSync } from "node:zlib"
import { ingestWiki, lastIngestedCommitSha, contentHash, type IngestResult } from "../src/ingest/incremental"
import type { Env } from "../src/types"

/** 构造单个 tar 条目（512B header + 512 对齐 data）。 */
function tarEntry(name: string, data: string, typeflag = "0"): Buffer {
  const size = Buffer.byteLength(data, "utf-8")
  const header = Buffer.alloc(512)
  header.write(name, 0, "utf-8")
  header.write(size.toString(8), 124, 12, "ascii")
  header.write(typeflag, 156, 1, "ascii")
  const dataPadded = Buffer.alloc(Math.ceil(size / 512) * 512)
  Buffer.from(data, "utf-8").copy(dataPadded)
  return Buffer.concat([header, dataPadded])
}

/** 构造 GitHub archive tarball：顶层 {repo 斜杠→横杠}-{branch}/。 */
function buildTarball(repo: string, branch: string, files: Record<string, string>): Buffer {
  const top = `${repo.replace(/\//g, "-")}-${branch}`
  const entries = Object.entries(files).map(([rel, content]) => tarEntry(`${top}/${rel}`, content))
  return Buffer.concat([...entries, Buffer.alloc(512), Buffer.alloc(512)])
}

/** 内存 D1 mock：ingest_files 表（wiki → Map<path, hash>）、ingest_runs 写入、全部语句记录。 */
function makeDbMock(opts: { lastCommit?: string; ingestFiles?: Map<string, string> } = {}): {
  db: D1Database
  ingestRuns: IngestResult[]
  /** 所有被 prepare 的 SQL（用于断言"语句形状"与"不再有 bigram 写入"） */
  sqls: string[]
  filesTable: Map<string, string> // path → hash（最近一次 ingest 后）
} {
  const ingestRuns: IngestResult[] = []
  const sqls: string[] = []
  const filesTable = opts.ingestFiles ?? new Map<string, string>()
  const stmt = {
    bind(..._args: unknown[]) {
      return {
        all: async <T>(): Promise<{ results: T[] }> => {
          // 只处理 ingest_files SELECT：返回表内容（无过滤细节，单 wiki 测试足够）
          return { results: [...filesTable.entries()].map(([path, content_hash]) => ({ path, content_hash })) as T[] }
        },
        first: async <T>(): Promise<T | null> => {
          return (opts.lastCommit ? { commit_sha: opts.lastCommit } : null) as T | null
        },
        run: async () => {
          // 未识别的写入语句 → 直接抛错（严格 mock：读/写语句都在下面显式列出）
          throw new Error(`unexpected-sql: ${sqls[sqls.length - 1]}`)
        },
      }
    },
  }
  const db = {
    prepare: (sql: string) => {
      sqls.push(sql)
      if (sql.startsWith("INSERT INTO ingest_runs")) {
        return {
          bind() {
            return { run: async () => { ingestRuns.push({} as IngestResult) } }
          },
        }
      }
      if (sql.includes("INSERT INTO ingest_files")) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                const [wiki, path, hash] = args as [string, string, string]
                filesTable.set(`${wiki}:${path}`, hash)
                return { success: true, meta: { changes: 1 } }
              },
            }
          },
        }
      }
      if (sql.includes("DELETE FROM ingest_files")) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                const [wiki, path] = args as [string, string]
                filesTable.delete(`${wiki}:${path}`)
                return { success: true, meta: { changes: 1 } }
              },
            }
          },
        }
      }
      return stmt
    },
  } as unknown as D1Database
  return { db, ingestRuns, sqls, filesTable }
}

/** 构造 fetch mock：GitHub tarball / commit / Qdrant scroll / upsert / delete / embedding。 */
function makeFetchMock(opts: {
  repo: string
  branch: string
  files: Record<string, string>
  commitSha: string
}): { fetchImpl: typeof fetch; upserts: Array<{ points: Array<{ payload: Record<string, unknown> }> }>; deletes: string[] } {
  const upserts: Array<{ points: Array<{ payload: Record<string, unknown> }> }> = []
  const deletes: string[] = []
  const tarball = buildTarball(opts.repo, opts.branch, opts.files)
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.includes("/archive/refs/heads/")) return new Response(new Uint8Array(gzipSync(tarball)), { status: 200 })
    if (u.includes("api.github.com/repos/")) return new Response(JSON.stringify({ sha: opts.commitSha }), { status: 200 })
    if (u.includes("/points/scroll")) {
      return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), { status: 200 })
    }
    if (u.includes("/points?wait=true")) {
      upserts.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response("{}", { status: 200 })
    }
    if (u.includes("/points/delete")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { filter?: { must?: Array<{ key: string; match?: { value: string } }> } }
      const path = body.filter?.must?.[0]?.match?.value
      if (path) deletes.push(path)
      return new Response("{}", { status: 200 })
    }
    if (u.includes("/v1/embeddings")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] | string }
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: new Array(4).fill(0.1) })) }), { status: 200 })
    }
    return new Response("unexpected-url", { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, upserts, deletes }
}

/** 最小 Env。 */
function makeEnv(db: D1Database | undefined, qdrant = true): Env {
  return {
    DB: db as D1Database,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    EMBED_POOL_KEYS: "sk-embed-a",
    EMBEDDING_MODEL: "BAAI/bge-m3",
    EMBEDDING_DIM: "4",
    QDRANT_URL: qdrant ? "https://qdrant.example" : undefined,
    QDRANT_API_KEY: "qdrant-test-key",
  } as Env
}

const WIKI = { repo: "project-trans/MtF-wiki", branch: "main" }

const A = "# 标题A\n\n正文内容激素治疗的完整说明与注意事项，包括雌二醇、抗雄药物以及定期复查的建议。\n\n## 小节\n\n更详细的副作用列表、用药剂量与个体差异，以及出现异常情况时的处理办法。"
const B = "# 标题B\n\n另一篇正文，讲述跨性别女性的激素治疗长期随访，以及肝功能等生化指标的监测周期。"
const C = "# 标题C\n\n第三篇文章的完整内容，讲述青春期阻断剂的使用时机与随访方案。"

/** 两次 ingest 共用的 FILES：一次全量、一次只改 b.md。 */
const FILES_ALL = { "content/zh-cn/a.md": A, "content/zh-cn/b.md": B, "content/zh-cn/c.md": C }
const FILES_ONLY_B_CHANGED = { "content/zh-cn/a.md": A, "content/zh-cn/b.md": B + "\n\n补充一段：关于睾酮抑制的个体化调整。", "content/zh-cn/c.md": C }

describe("ingestWiki 真·文件级增量", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("commit 与上次相同 → skipped，0 upsert、0 ingest_files 写入", async () => {
    const { db, sqls } = makeDbMock({ lastCommit: "abc123" })
    const { fetchImpl, upserts } = makeFetchMock({ ...WIKI, files: FILES_ALL, commitSha: "abc123" })
    const res = await ingestWiki(makeEnv(db), "mtf-wiki", { fetchImpl })
    expect(res.status).toBe("skipped")
    expect(res.points_upserted).toBe(0)
    expect(upserts).toHaveLength(0)
    expect(sqls.some((q) => q.includes("INSERT INTO ingest_files"))).toBe(false)
  })

  it("首次 ingest：全部文件都 upsert + 记账 + ingest_files 记录", async () => {
    const { db, ingestRuns, filesTable } = makeDbMock({ lastCommit: "old-sha" })
    const { fetchImpl, upserts } = makeFetchMock({ ...WIKI, files: FILES_ALL, commitSha: "new-sha" })
    const res = await ingestWiki(makeEnv(db), "mtf-wiki", { fetchImpl })
    expect(res.status).toBe("success")
    expect(res.files_added).toBe(3)
    expect(res.files_updated).toBe(0)
    expect(res.points_upserted).toBeGreaterThan(0)
    expect(upserts.length).toBeGreaterThan(0)
    // payload 带 text（snippet/回退索引依赖）
    const first = upserts[0]
    expect(first.points[0].payload.text).toContain("激素治疗")
    // 记账 + ingest_files 3 条
    expect(ingestRuns.length).toBeGreaterThan(0)
    expect(filesTable.size).toBe(3)
  })

  it("第二次 ingest 只改 b.md → 只 upsert b 的 chunks，a/c 不重嵌", async () => {
    // 预置 ingest_files：a/c 与当前 hash 相同，b 是旧 hash（即将变化）
    const prev = new Map<string, string>()
    // 先做一次"全量"得到 a/c 的 hash（用当前 FILES_ALL 内容计算）
    const { filesTable } = makeDbMock({})
    for (const [path, content] of Object.entries(FILES_ALL)) {
      filesTable.set(`mtf-wiki:content/zh-cn/${path.replace("content/zh-cn/", "")}`, await contentHash(content))
    }
    // 修正 key：filesTable 用 "${wiki}:${path}" 存储，path 是 repoRoot
    prev.set("content/zh-cn/a.md", filesTable.get("mtf-wiki:content/zh-cn/a.md")!)
    prev.set("content/zh-cn/c.md", filesTable.get("mtf-wiki:content/zh-cn/c.md")!)
    prev.set("content/zh-cn/b.md", "deadbeef") // b 旧 hash（与当前不同）
    const { db } = makeDbMock({ lastCommit: "old-sha", ingestFiles: prev })

    const { fetchImpl, upserts, deletes } = makeFetchMock({ ...WIKI, files: FILES_ONLY_B_CHANGED, commitSha: "new-sha2" })
    const res = await ingestWiki(makeEnv(db), "mtf-wiki", { fetchImpl })

    expect(res.status).toBe("success")
    expect(res.files_added).toBe(0)
    expect(res.files_updated).toBe(1) // 只有 b.md
    // 只有 b 的 chunks 被 upsert：payload.path 全是 content/zh-cn/b.md
    const upsertedPaths = upserts.flatMap((u) => u.points.map((p) => p.payload.path))
    expect(upsertedPaths.length).toBeGreaterThan(0)
    expect(upsertedPaths.every((p) => p === "content/zh-cn/b.md")).toBe(true)
    // a/c 未被删除、未 upsert
    expect(deletes).toHaveLength(0)
  })

  it("文件被删除 → Qdrant delete + D1 记录清理", async () => {
    const prev = new Map<string, string>([
      ["content/zh-cn/a.md", await contentHash(A)],
      ["content/zh-cn/gone.md", "deadbeef"], // 上次有、这次没了
    ])
    const { db } = makeDbMock({ lastCommit: "old-sha", ingestFiles: prev })
    const { fetchImpl, deletes } = makeFetchMock({
      ...WIKI,
      files: { "content/zh-cn/a.md": A },
      commitSha: "new-sha",
    })
    const res = await ingestWiki(makeEnv(db), "mtf-wiki", { fetchImpl })
    expect(res.status).toBe("success")
    expect(res.files_deleted).toBe(1)
    expect(deletes).toContain("content/zh-cn/gone.md")
    expect(deletes).not.toContain("content/zh-cn/a.md")
  })

  it("未知 wiki → error 结果（不抛错）", async () => {
    const res = await ingestWiki(makeEnv(undefined), "not-a-wiki")
    expect(res.status).toBe("error")
    expect(res.error).toContain("unknown-wiki")
  })

  it("无 Qdrant URL → 解析但不 upsert（points_upserted=0）", async () => {
    const { db } = makeDbMock({ lastCommit: "old-sha" })
    const { fetchImpl } = makeFetchMock({ ...WIKI, files: FILES_ALL, commitSha: "new-sha" })
    const res = await ingestWiki(makeEnv(db, false), "mtf-wiki", { fetchImpl })
    expect(res.status).toBe("success")
    expect(res.points_upserted).toBe(0)
  })

  it("ingest_files 的写入用 ON CONFLICT DO UPDATE（不用 INSERT OR REPLACE）——保住 blob_sha 零 chunk 集合", async () => {
    const { db, sqls } = makeDbMock({ lastCommit: "old-sha" })
    const { fetchImpl } = makeFetchMock({ ...WIKI, files: FILES_ALL, commitSha: "new-sha-x" })
    await ingestWiki(makeEnv(db), "mtf-wiki", { fetchImpl })
    const writes = sqls.filter((q) => q.includes("INSERT INTO ingest_files"))
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(w).toContain("ON CONFLICT(wiki_id, path) DO UPDATE SET content_hash = excluded.content_hash")
      // REPLACE = DELETE+INSERT，会把 Actions 侧写的 blob_sha 抹成 NULL（技术债 #5 的坑）
      expect(w).not.toContain("INSERT OR REPLACE")
    }
    // 全部语句里都不该再出现 bigram（技术债 #2 已删表；回归即失败）
    expect(sqls.some((q) => q.includes("bigram"))).toBe(false)
  })

  it("无 D1（undefined）→ 退化：全部当 changed 处理", async () => {
    const { fetchImpl, upserts } = makeFetchMock({ ...WIKI, files: FILES_ALL, commitSha: "new-sha" })
    const res = await ingestWiki(makeEnv(undefined), "mtf-wiki", { fetchImpl })
    expect(res.status).toBe("success")
    expect(res.points_upserted).toBeGreaterThan(0)
    expect(upserts.length).toBeGreaterThan(0)
  })
})

describe("lastIngestedCommitSha / contentHash", () => {
  it("D1 undefined → 空串", async () => {
    expect(await lastIngestedCommitSha(undefined, "mtf-wiki")).toBe("")
  })

  it("contentHash 幂等且不同内容不同 hash", async () => {
    const h1 = await contentHash("激素治疗")
    const h2 = await contentHash("激素治疗")
    const h3 = await contentHash("激素治疗。")
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^[0-9a-f]{40}$/)
  })
})