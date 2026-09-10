// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 多轮会话 + 自定义模型单测（tasks.md T3.4 / T3.5）
// 覆盖：
//   1) chat_sessions：轮次上限 10、history 超长截断、缺 D1 优雅降级（null / ok:false，不抛错）；
//   2) 自定义模型 api_key：AES-GCM 加解密往返、密文不含明文、缺密钥抛可识别配置错误、越权读不到；
//   3) SSRF 校验：拒绝 http:// 与内网/回环/链路本地/单标签主机名；
//   4) 调用错误信息绝不回显 key。
// 全部 mock，不触真实上游；断言里只有占位串，不含任何真实 key。
import { describe, it, expect } from "vitest"
import { deleteCustomModel } from "../src/custommodel"
import {
  CHAT_MAX_HISTORY_MESSAGES,
  CHAT_MAX_MESSAGE_CHARS,
  CHAT_MAX_ROUNDS,
  appendRound,
  createSession,
  historyToMessages,
  isMaxRounds,
  loadContext,
  type ChatDb,
  type ChatStmt,
} from "../src/chat"
import {
  CUSTOM_MODEL_CIPHER_PREFIX,
  listCustomModels,
  CUSTOM_MODEL_DDL,
  CustomModelError,
  base64ToBytes,
  bytesToBase64,
  callCustomModel,
  decryptApiKey,
  encryptApiKey,
  isBlockedHost,
  loadCustomModel,
  maskApiKey,
  resolveChatCompletionsUrl,
  saveCustomModel,
  validateModelConfig,
  type CustomModelDb,
  type CustomModelStmt,
} from "../src/custommodel"
import { LLM_MAX_HITS, type LlmHit } from "../src/llm"

/** 占位 key（不是真实 key）。 */
const KEY_A = "test-key-a"
const ENC_KEY = "unit-test-enc-key-0123456789"

/** 造 hit。 */
function makeHits(n: number): LlmHit[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hit-${i + 1}`,
    title: `标题${i + 1}`,
    url: `https://example.test/${i + 1}`,
    text: `正文${i + 1}`,
  }))
}

// ─────────────────────────────────────────────
// D1 mock（chat_sessions）
// ─────────────────────────────────────────────

function makeChatDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const calls: { sql: string; args: unknown[] }[] = []
  const db: ChatDb = {
    prepare(sql: string): ChatStmt {
      const rec = { sql, args: [] as unknown[] }
      const stmt: ChatStmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(rec)
          return stmt
        },
        async first<T>(): Promise<T | null> {
          if (/FROM chat_sessions/i.test(sql)) return (rows.get(String(rec.args[0])) ?? null) as T | null
          return null
        },
        async run(): Promise<unknown> {
          if (/INSERT INTO chat_sessions/i.test(sql)) {
            const [id, account_id, model_id, corpora, round_count, initial_hits, history, created_at, updated_at] =
              rec.args
            rows.set(String(id), {
              id,
              account_id,
              model_id,
              corpora,
              round_count,
              initial_hits,
              history,
              created_at,
              updated_at,
            })
          } else if (/UPDATE chat_sessions/i.test(sql)) {
            const [round_count, history, updated_at, id] = rec.args
            const row = rows.get(String(id))
            if (row) Object.assign(row, { round_count, history, updated_at })
          }
          return { success: true }
        },
      }
      return stmt
    },
  }
  return { db, rows, calls }
}

// ─────────────────────────────────────────────
// D1 mock（custom_models）
// ─────────────────────────────────────────────

function makeCustomModelDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const db: CustomModelDb = {
    prepare(sql: string): CustomModelStmt {
      const rec = { sql, args: [] as unknown[] }
      const stmt: CustomModelStmt = {
        bind(...args: unknown[]) {
          rec.args = args
          return stmt
        },
        async first<T>(): Promise<T | null> {
          const [id, accountId] = rec.args
          const row = rows.get(String(id))
          if (!row || row.account_id !== accountId) return null
          if (/SELECT api_key_enc/i.test(sql)) return { api_key_enc: row.api_key_enc } as T
          return row as T
        },
        async all<T>(): Promise<{ results?: T[] } | null> {
          const [accountId] = rec.args
          const list = [...rows.values()].filter((r) => r.account_id === accountId)
          return { results: list as T[] }
        },
        async run(): Promise<unknown> {
          if (/INSERT INTO custom_models/i.test(sql)) {
            const [id, account_id, name, base_url, model, api_key_enc, created_at, updated_at] = rec.args
            rows.set(String(id), { id, account_id, name, base_url, model, api_key_enc, created_at, updated_at })
          } else if (/UPDATE custom_models/i.test(sql)) {
            const [name, base_url, model, api_key_enc, updated_at, id, accountId] = rec.args
            const row = rows.get(String(id))
            if (row && row.account_id === accountId) Object.assign(row, { name, base_url, model, api_key_enc, updated_at })
          }
          return { success: true }
        },
      }
      return stmt
    },
  }
  return { db, rows }
}

// ─────────────────────────────────────────────
// chat.ts
// ─────────────────────────────────────────────

describe("chat_sessions：创建 / 读取 / 轮次上限 / 截断 / 缺 D1 降级", () => {
  it("创建会话：initial_hits 截断到 6 条、corpora 落 JSON、轮次归零", async () => {
    const { db, rows } = makeChatDb()
    const ctx = await createSession(db, "acc-1", "default", ["mtf-wiki", "rle-wiki"], makeHits(9), 1_700_000_000_000)
    expect(ctx).not.toBeNull()
    expect(LLM_MAX_HITS).toBe(6)
    expect(ctx!.initialHits).toHaveLength(6)
    expect(ctx!.corpora).toEqual(["mtf-wiki", "rle-wiki"])
    expect(ctx!.roundCount).toBe(0)
    expect(ctx!.history).toEqual([])

    const row = rows.get(ctx!.id)!
    expect(JSON.parse(String(row.initial_hits))).toHaveLength(6)
    expect(JSON.parse(String(row.corpora))).toEqual(["mtf-wiki", "rle-wiki"])
  })

  it("缺 D1 / 缺 accountId → createSession 返回 null，不抛错", async () => {
    expect(await createSession(null, "acc-1", "default", [], makeHits(1), 1)).toBeNull()
    expect(await createSession(undefined, "acc-1", "default", [], makeHits(1), 1)).toBeNull()
    expect(await createSession(makeChatDb().db, "", "default", [], makeHits(1), 1)).toBeNull()
  })

  it("loadContext：会话不存在 → null；缺 D1 → null；脏 JSON → 空数组不炸", async () => {
    const { db, rows } = makeChatDb()
    expect(await loadContext(db, "nope")).toBeNull()
    expect(await loadContext(null, "nope")).toBeNull()

    const ctx = await createSession(db, "acc-1", "default", ["mtf-wiki"], makeHits(2), 1)!
    rows.get(ctx!.id)!.history = "{ not json"
    rows.get(ctx!.id)!.initial_hits = "[]"
    const loaded = await loadContext(db, ctx!.id)
    expect(loaded!.history).toEqual([])
    expect(loaded!.initialHits).toEqual([])
    expect(loaded!.corpora).toEqual(["mtf-wiki"])
  })

  it(`user 轮次上限 ${CHAT_MAX_ROUNDS} 轮，第 11 轮返回 max-rounds`, async () => {
    const { db } = makeChatDb()
    const ctx = await createSession(db, "acc-1", "default", ["mtf-wiki"], makeHits(1), 0)
    for (let i = 1; i <= CHAT_MAX_ROUNDS; i++) {
      const res = await appendRound(db, ctx!.id, "user", `第${i}问`, i * 10)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.context.roundCount).toBe(i)
      // 每问都配一条回答（不计数）
      const ans = await appendRound(db, ctx!.id, "assistant", `第${i}答`, i * 10 + 1)
      expect(ans.ok).toBe(true)
      if (ans.ok) expect(ans.context.roundCount).toBe(i)
    }
    const overflow = await appendRound(db, ctx!.id, "user", "第11问", 999)
    expect(overflow).toEqual({ ok: false, reason: "max-rounds" })

    const ctx2 = await loadContext(db, ctx!.id)
    expect(isMaxRounds(ctx2)).toBe(true)
    expect(ctx2!.roundCount).toBe(CHAT_MAX_ROUNDS)
  })

  it("history 超长丢弃最旧消息（截断标记 true），单条内容截断到 4000 字", async () => {
    const { db } = makeChatDb()
    const ctx = await createSession(db, "acc-1", "default", ["mtf-wiki"], makeHits(1), 0)
    // 轮次上限只约束 user，故用 assistant 消息把 history 撑爆
    let last = null as Awaited<ReturnType<typeof appendRound>> | null
    for (let i = 0; i < CHAT_MAX_HISTORY_MESSAGES + 5; i++) {
      last = await appendRound(db, ctx!.id, "assistant", `消息${i}`, i)
    }
    expect(last!.ok).toBe(true)
    if (last!.ok) {
      expect(last!.truncated).toBe(true)
      expect(last!.context.history).toHaveLength(CHAT_MAX_HISTORY_MESSAGES)
      expect(last!.context.history[0].content).toBe(`消息5`)
    }
    const long = await appendRound(db, ctx!.id, "assistant", "字".repeat(CHAT_MAX_MESSAGE_CHARS + 500), 9999)
    if (long.ok) {
      const lastMsg = long.context.history[long.context.history.length - 1]
      expect(lastMsg.content.length).toBeLessThanOrEqual(CHAT_MAX_MESSAGE_CHARS)
    }
  })

  it("appendRound 的降级分支：缺 D1 / 会话不存在 / 空内容", async () => {
    const { db } = makeChatDb()
    expect(await appendRound(null, "s1", "user", "hi", 1)).toEqual({ ok: false, reason: "db-unavailable" })
    expect(await appendRound(db, "missing", "user", "hi", 1)).toEqual({ ok: false, reason: "session-not-found" })
    const ctx = await createSession(db, "acc-1", "default", [], makeHits(1), 0)
    expect(await appendRound(db, ctx!.id, "user", "   ", 1)).toEqual({ ok: false, reason: "invalid-round" })
  })

  it("historyToMessages 只保留最近 20 条并映射为 LLM 消息", async () => {
    const { db } = makeChatDb()
    const ctx = await createSession(db, "acc-1", "default", [], makeHits(1), 0)
    for (let i = 0; i < 25; i++) await appendRound(db, ctx!.id, i % 2 ? "assistant" : "user", `m${i}`, i)
    const loaded = await loadContext(db, ctx!.id)
    const msgs = historyToMessages(loaded!.history)
    expect(msgs).toHaveLength(CHAT_MAX_HISTORY_MESSAGES)
    expect(msgs[0]).toEqual({ role: expect.any(String), content: expect.any(String) })
    expect(Object.keys(msgs[0])).toEqual(["role", "content"])
  })
})

// ─────────────────────────────────────────────
// custommodel.ts：加密
// ─────────────────────────────────────────────

describe("custommodel：api_key AES-GCM 加解密", () => {
  it("加解密往返一致，密文不含明文，且随机 IV 使两次结果不同", async () => {
    const env = { CUSTOM_MODEL_ENC_KEY: ENC_KEY }
    const plain = "user-provided-secret-key-abc123"
    const blob1 = await encryptApiKey(env, plain)
    const blob2 = await encryptApiKey(env, plain)
    expect(blob1.startsWith(CUSTOM_MODEL_CIPHER_PREFIX)).toBe(true)
    expect(blob1).not.toContain(plain)
    expect(blob2).not.toContain(plain)
    expect(blob1).not.toBe(blob2) // 随机 IV
    expect(await decryptApiKey(env, blob1)).toBe(plain)
    expect(await decryptApiKey(env, blob2)).toBe(plain)
  })

  it("支持 base64 的 32 字节密钥（直接导入路径）", async () => {
    const rawKey = bytesToBase64(new Uint8Array(32).map((_, i) => i * 7 + 1))
    expect(base64ToBytes(rawKey)).toHaveLength(32)
    const env = { CUSTOM_MODEL_ENC_KEY: rawKey }
    const blob = await encryptApiKey(env, "another-secret")
    expect(await decryptApiKey(env, blob)).toBe("another-secret")
  })

  it("缺密钥 / 密钥过短 → 抛可识别配置错误，绝不退化为明文", async () => {
    await expect(encryptApiKey({}, "x")).rejects.toMatchObject({ name: "CustomModelError", code: "enc-key-missing" })
    await expect(encryptApiKey(undefined, "x")).rejects.toMatchObject({ code: "enc-key-missing" })
    await expect(encryptApiKey({ CUSTOM_MODEL_ENC_KEY: "short" }, "x")).rejects.toMatchObject({
      code: "enc-key-invalid",
    })
    await expect(decryptApiKey({}, "v1:abc")).rejects.toMatchObject({ code: "enc-key-missing" })
  })

  it("密钥不符 / 密文被篡改 / 格式非法 → decrypt-failed", async () => {
    const blob = await encryptApiKey({ CUSTOM_MODEL_ENC_KEY: ENC_KEY }, "secret-value")
    await expect(decryptApiKey({ CUSTOM_MODEL_ENC_KEY: "another-enc-key-0123456789" }, blob)).rejects.toMatchObject({
      code: "decrypt-failed",
    })
    const tampered = CUSTOM_MODEL_CIPHER_PREFIX + blob.slice(CUSTOM_MODEL_CIPHER_PREFIX.length, -4) + "AAAA"
    await expect(decryptApiKey({ CUSTOM_MODEL_ENC_KEY: ENC_KEY }, tampered)).rejects.toMatchObject({
      code: "decrypt-failed",
    })
    await expect(decryptApiKey({ CUSTOM_MODEL_ENC_KEY: ENC_KEY }, "plaintext")).rejects.toMatchObject({
      code: "decrypt-failed",
    })
  })

  it("maskApiKey 只露最后 4 位", () => {
    expect(maskApiKey("abcdefgh")).toBe("****efgh")
    expect(maskApiKey("abc")).toBe("****")
    expect(maskApiKey("")).toBe("")
  })
})

// ─────────────────────────────────────────────
// custommodel.ts：校验 + SSRF
// ─────────────────────────────────────────────

describe("custommodel：validateModelConfig + SSRF 防护", () => {
  it("只允许 https 且拒绝内网/回环/链路本地/单标签主机名", () => {
    const blocked = [
      "http://api.openai.com/v1",
      "https://localhost/v1",
      "https://api.localhost/v1",
      "https://127.0.0.1/v1",
      "https://127.1.2.3/v1",
      "https://10.0.0.5/v1",
      "https://192.168.1.10/v1",
      "https://172.16.0.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/v1",
      "https://100.64.0.1/v1",
      "https://[::1]/v1",
      "https://[fd00::1]/v1",
      "https://2130706433/v1",
      "https://internal-host/v1",
      "https://metadata.google.internal/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/v1?x=1",
    ]
    for (const url of blocked) {
      const r = validateModelConfig({ base_url: url, model: "gpt-4o-mini" })
      expect(r.ok, `${url} 应被拒绝`).toBe(false)
    }
  })

  it("接受合法公网 https 端点并规范化尾斜杠", () => {
    const r = validateModelConfig({ base_url: "https://api.openai.com/v1/", model: "gpt-4o-mini" })
    expect(r).toEqual({ ok: true, base_url: "https://api.openai.com/v1" })
    const r2 = validateModelConfig({ base_url: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-4B" })
    expect(r2.ok).toBe(true)
  })

  it("model 非空且有长度上限；base_url 长度上限", () => {
    expect(validateModelConfig({ base_url: "https://api.openai.com/v1", model: "" })).toMatchObject({
      ok: false,
      code: "invalid-model",
    })
    expect(
      validateModelConfig({ base_url: "https://api.openai.com/v1", model: "m".repeat(300) }),
    ).toMatchObject({ ok: false, code: "invalid-model" })
    expect(
      validateModelConfig({ base_url: `https://api.openai.com/${"a".repeat(600)}`, model: "m" }),
    ).toMatchObject({ ok: false, code: "invalid-base-url" })
  })

  it("isBlockedHost 单元断言（内网段 / IPv4-mapped IPv6 / 单标签）", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true)
    expect(isBlockedHost("10.1.1.1")).toBe(true)
    expect(isBlockedHost("192.168.0.1")).toBe(true)
    expect(isBlockedHost("169.254.169.254")).toBe(true)
    expect(isBlockedHost("localhost")).toBe(true)
    expect(isBlockedHost("printer")).toBe(true)
    expect(isBlockedHost("::ffff:127.0.0.1")).toBe(true)
    expect(isBlockedHost("api.openai.com")).toBe(false)
    expect(isBlockedHost("8.8.8.8")).toBe(false)
  })

  it("resolveChatCompletionsUrl 拼接不重复", () => {
    expect(resolveChatCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions")
    expect(resolveChatCompletionsUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
    expect(resolveChatCompletionsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/chat/completions")
  })

  it("导出 DDL 常量（需 captain 应用到 D1，不改 schema.sql）", () => {
    expect(CUSTOM_MODEL_DDL).toContain("CREATE TABLE IF NOT EXISTS custom_models")
    expect(CUSTOM_MODEL_DDL).toContain("api_key_enc")
  })
})

// ─────────────────────────────────────────────
// custommodel.ts：调用 + 落库
// ─────────────────────────────────────────────

describe("custommodel：callCustomModel 与落库", () => {
  it("OpenAI 兼容调用成功，返回文本与用量", async () => {
    const seen: { url: string; auth: string; body: Record<string, unknown> }[] = []
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "回答 [来源1]" } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
        text: async () => "",
      }
    }) as unknown as typeof fetch

    const out = await callCustomModel(
      { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: KEY_A },
      [{ role: "user", content: "hi" }],
      fetchImpl,
    )
    expect(out.text).toBe("回答 [来源1]")
    expect(out.tokens_in).toBe(5)
    expect(out.tokens_out).toBe(7)
    expect(out.estimated).toBe(false)
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions")
    expect(seen[0].auth).toBe(`Bearer ${KEY_A}`)
    expect(seen[0].body.model).toBe("gpt-4o-mini")
    expect(seen[0].body.stream).toBe(false)
  })

  it("上游报错时不回显 key（即使上游 body 里带着 key）", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => `invalid api key ${KEY_A} (Bearer ${KEY_A})`,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch

    const err = (await callCustomModel(
      { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: KEY_A },
      [{ role: "user", content: "hi" }],
      fetchImpl,
    ).catch((e: unknown) => e)) as CustomModelError

    expect(err.code).toBe("custom-model-http")
    expect(err.status).toBe(401)
    expect(err.message).not.toContain(KEY_A)
    expect(err.message).toContain("[redacted]")
  })

  it("超时 / 空回复 / 非法配置都有可识别错误码", async () => {
    const timeoutFetch = (async (_url: string, init: { signal: AbortSignal }) =>
      await new Promise<Response>((_res, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted")
          e.name = "AbortError"
          reject(e)
        })
      })) as unknown as typeof fetch
    await expect(
      callCustomModel(
        { base_url: "https://api.openai.com/v1", model: "m", api_key: KEY_A },
        [],
        timeoutFetch,
        { timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ code: "custom-model-timeout" })

    const emptyFetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [] }), text: async () => "" }) as unknown as Response) as unknown as typeof fetch
    await expect(
      callCustomModel({ base_url: "https://api.openai.com/v1", model: "m", api_key: KEY_A }, [], emptyFetch),
    ).rejects.toMatchObject({ code: "custom-model-empty" })

    await expect(
      callCustomModel({ base_url: "http://api.openai.com/v1", model: "m", api_key: KEY_A }, [], emptyFetch),
    ).rejects.toMatchObject({ code: "insecure-base-url" })

    await expect(
      callCustomModel({ base_url: "https://api.openai.com/v1", model: "m", api_key: "" }, [], emptyFetch),
    ).rejects.toMatchObject({ code: "invalid-model" })
  })

  it("落库：密文不含明文、读取可解密、越权读不到", async () => {
    const { db, rows } = makeCustomModelDb()
    const env = { CUSTOM_MODEL_ENC_KEY: ENC_KEY }
    const saved = await saveCustomModel(
      db,
      env,
      "acc-1",
      { base_url: "https://api.openai.com/v1/", model: "gpt-4o-mini", api_key: "user-secret-9999", name: "我的模型" },
      1_700_000_000_000,
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.model.api_key_masked).toBe("****9999")
    expect(saved.model.base_url).toBe("https://api.openai.com/v1")

    const row = rows.get(saved.model.id)!
    expect(String(row.api_key_enc).startsWith(CUSTOM_MODEL_CIPHER_PREFIX)).toBe(true)
    expect(String(row.api_key_enc)).not.toContain("user-secret-9999")

    // 本人可读并解密
    const loaded = await loadCustomModel(db, env, "acc-1", saved.model.id)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.config.api_key).toBe("user-secret-9999")
      expect(loaded.config.base_url).toBe("https://api.openai.com/v1")
    }

    // 越权：别人拿不到
    const other = await loadCustomModel(db, env, "acc-2", saved.model.id)
    expect(other).toEqual({ ok: false, code: "not-found", reason: "not-found" })

    // 缺加密密钥时读不出（返回可识别错误，而不是抛未捕获异常）
    const noKey = await loadCustomModel(db, {}, "acc-1", saved.model.id)
    expect(noKey.ok).toBe(false)
  })

  it("保存时校验失败 / 缺 key / 缺 D1 都有可识别返回", async () => {
    const { db } = makeCustomModelDb()
    const env = { CUSTOM_MODEL_ENC_KEY: ENC_KEY }
    expect(await saveCustomModel(null, env, "acc-1", { base_url: "https://a.com", model: "m" }, 0)).toMatchObject({
      ok: false,
      code: "db-unavailable",
    })
    expect(
      await saveCustomModel(db, env, "acc-1", { base_url: "http://a.com", model: "m", api_key: KEY_A }, 0),
    ).toMatchObject({ ok: false, code: "insecure-base-url" })
    expect(
      await saveCustomModel(db, env, "acc-1", { base_url: "https://a.com", model: "m" }, 0),
    ).toMatchObject({ ok: false, code: "invalid-model", reason: "api-key-required" })
    expect(
      await saveCustomModel(db, {}, "acc-1", { base_url: "https://a.com", model: "m", api_key: KEY_A }, 0),
    ).toMatchObject({ ok: false, code: "enc-key-missing" })
  })

  it("listCustomModels 只回元信息（无 key），缺 D1 返回空数组", async () => {
    const { db } = makeCustomModelDb()
    const env = { CUSTOM_MODEL_ENC_KEY: ENC_KEY }
    expect(await listCustomModels(null, "acc-1")).toEqual([])
    expect(await listCustomModels(db, "acc-1")).toEqual([])

    await saveCustomModel(
      db,
      env,
      "acc-1",
      { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: "list-secret-4321", name: "A" },
      1,
    )
    await saveCustomModel(
      db,
      env,
      "acc-2",
      { base_url: "https://api.openai.com/v1", model: "gpt-4o", api_key: "other-secret-0000", name: "B" },
      2,
    )
    const list = await listCustomModels(db, "acc-1")
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("A")
    expect(list[0].key_configured).toBe(true)
    expect(JSON.stringify(list)).not.toContain("list-secret-4321")
    expect(JSON.stringify(list)).not.toContain("v1:")
  })

  it("更新时不给 api_key 则复用旧密文", async () => {
    const { db, rows } = makeCustomModelDb()
    const env = { CUSTOM_MODEL_ENC_KEY: ENC_KEY }
    const first = await saveCustomModel(
      db,
      env,
      "acc-1",
      { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: "keep-me-1234" },
      1,
    )
    if (!first.ok) throw new Error("setup failed")
    const encBefore = rows.get(first.model.id)!.api_key_enc

    const updated = await saveCustomModel(
      db,
      env,
      "acc-1",
      { base_url: "https://api.openai.com/v1", model: "gpt-4o", name: "改名" },
      2,
      first.model.id,
    )
    expect(updated.ok).toBe(true)
    expect(rows.get(first.model.id)!.api_key_enc).toBe(encBefore)
    expect(rows.get(first.model.id)!.model).toBe("gpt-4o")

    const loaded = await loadCustomModel(db, env, "acc-1", first.model.id)
    if (loaded.ok) expect(loaded.config.api_key).toBe("keep-me-1234")
  })
})

// ── T3.5 补充：自定义模型删除（越权/不存在 → not-found；缺 D1 → db-unavailable）──
describe("deleteCustomModel", () => {
  function makeDeleteDb(changes: number, throwErr = false) {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const stmt = (sql: string) => {
      const rec = { sql, args: [] as unknown[] }
      const self = {
        bind(...a: unknown[]) {
          rec.args = a
          calls.push(rec)
          return self
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => {
          if (throwErr) throw new Error("d1-error")
          return { success: true, meta: { changes } }
        },
      }
      return self
    }
    return { db: { prepare: stmt } as never, calls }
  }

  it("删除成功返回 deleted=1，且 SQL 带 account_id（越权隔离）", async () => {
    const { db, calls } = makeDeleteDb(1)
    const res = await deleteCustomModel(db, "acc-1", "m-1")
    expect(res).toEqual({ ok: true, deleted: 1 })
    expect(calls[0].sql).toContain("DELETE FROM custom_models")
    expect(calls[0].sql).toContain("account_id")
    expect(calls[0].args).toEqual(["m-1", "acc-1"])
  })

  it("不存在 / 不属于本人（changes=0）→ not-found", async () => {
    const { db } = makeDeleteDb(0)
    const res = await deleteCustomModel(db, "acc-1", "other")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("not-found")
  })

  it("缺 D1 → db-unavailable；D1 抛错 → db-unavailable（不向上抛）", async () => {
    expect((await deleteCustomModel(null, "acc-1", "m-1")).ok).toBe(false)
    const { db } = makeDeleteDb(1, true)
    const res = await deleteCustomModel(db, "acc-1", "m-1")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("db-unavailable")
  })
})
