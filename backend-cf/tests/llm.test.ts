// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — LLM provider 单测（tasks.md T3.4）
// 覆盖：
//   1) buildPrompt 的截断（每条 ≤600 字 / 最多 6 条）与 [来源n] 约束、system 防胡说硬约束；
//   2) 换 key 重试：第一个 key 401 → 第二个 key 成功（withKeyRetry），且每 key 用量记账 endpoint="chat"；
//   3) 超时 / 池全灭 → 抛可识别 LLMError（调用方据此降级为纯搜索 + "AI总结暂不可用"）；
//   4) SSE 解析：`data: {...}\n\n` 流（含跨 chunk 半包）与流式总结；
//   5) 错误信息脱敏：绝不回显 key。
// 全部 mock，不触真实上游；断言里只有占位串，不含任何真实 key。
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  buildPrompt,
  createChatProvider,
  extractCitationIndices,
  extractDeltaContent,
  isLlmUnavailable,
  iterateSse,
  parseSseChunk,
  redactSecrets,
  streamSummary,
  summarize,
  LLM_DEFAULT_ENDPOINT,
  LLM_DEFAULT_MODEL,
  LLM_HIT_MAX_CHARS,
  LLM_MAX_HITS,
  LLM_MAX_HISTORY_MESSAGES,
  LLM_MAX_TOKENS,
  LLM_QUESTION_MAX_CHARS,
  LLM_SYSTEM_PROMPT,
  LLM_UNAVAILABLE_NOTICE,
  LLMError,
  type ChatMessage,
  type LlmHit,
} from "../src/llm"
import { KeyPool, type KeyPoolDb, type UsageRecord } from "../src/keypool"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 占位 key（不是真实 key，也不像真实格式）。 */
const KEY_A = "test-key-a"
const KEY_B = "test-key-b"

/** 内存版记账 mock。 */
function makeDb(): KeyPoolDb & { usage: UsageRecord[]; failures: unknown[] } {
  const usage: UsageRecord[] = []
  const failures: unknown[] = []
  return {
    usage,
    failures,
    async recordUsage(rec) {
      usage.push(rec)
    },
    async markFailure(pool, keyRef, reason) {
      failures.push({ pool, keyRef, reason })
    },
  }
}

/** 造 n 条 hit。 */
function makeHits(n: number, textLen = 40): LlmHit[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hit-${i + 1}`,
    title: `标题${i + 1}`,
    url: `https://example.test/doc/${i + 1}`,
    source: "mtf-wiki",
    text: `第${i + 1}条正文 ` + "字".repeat(textLen),
  }))
}

/** OpenAI 兼容的非流式成功响应。 */
function chatOk(content: string, tokensIn = 11, tokensOut = 22): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
    }),
    text: async () => "",
  } as unknown as Response
}

describe("buildPrompt（纯函数：截断 + 防胡说约束 + 引用锚点）", () => {
  it("最多只塞 6 条 hit，多余丢弃并计数", () => {
    const built = buildPrompt(makeHits(9), "HRT 是什么？")
    expect(LLM_MAX_HITS).toBe(6)
    expect(built.usedHits).toBe(6)
    expect(built.droppedHits).toBe(3)
    expect(built.citations).toHaveLength(6)
    expect(built.messages[built.messages.length - 1].content).toContain("【片段6】")
    expect(built.messages[built.messages.length - 1].content).not.toContain("【片段7】")
  })

  it("每条 hit 正文截断到 600 字以内，且计数 truncatedHits", () => {
    const built = buildPrompt(makeHits(1, 2_000), "问题")
    expect(LLM_HIT_MAX_CHARS).toBe(600)
    expect(built.truncatedHits).toBe(1)
    const user = built.messages[built.messages.length - 1].content
    // 正文段（去掉标题/链接行后）长度受控
    const body = user.split("正文：")[1].split("\n\n【用户问题】")[0]
    expect(body.length).toBeLessThanOrEqual(LLM_HIT_MAX_CHARS)
    expect(body.endsWith("…")).toBe(true)
  })

  it("system prompt 含防胡说硬约束（只依据片段 / 不得编造 / 不知道 / [来源n]）", () => {
    const built = buildPrompt(makeHits(2), "问题")
    expect(built.system).toBe(LLM_SYSTEM_PROMPT)
    expect(built.system).toContain("只依据")
    expect(built.system).toContain("不得编造")
    expect(built.system).toContain("不知道")
    expect(built.system).toContain("[来源1]")
    // messages 第一条必须是 system
    expect(built.messages[0]).toEqual({ role: "system", content: LLM_SYSTEM_PROMPT })
  })

  it("引用锚点编号与 [来源n] 一一对应，并可回跳 hits", () => {
    const built = buildPrompt(makeHits(3), "问题")
    expect(built.citations.map((c) => c.label)).toEqual(["来源1", "来源2", "来源3"])
    expect(built.citations.map((c) => c.index)).toEqual([1, 2, 3])
    expect(built.citations[1].url).toBe("https://example.test/doc/2")
    expect(built.citations[1].id).toBe("hit-2")
  })

  it("没有 hit 时明确要求回答「无法回答」，不硬编造", () => {
    const built = buildPrompt([], "问题")
    expect(built.usedHits).toBe(0)
    expect(built.citations).toHaveLength(0)
    expect(built.messages[built.messages.length - 1].content).toContain("无法回答")
  })

  it("超长问题与超长历史都被截断", () => {
    const history: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第${i}轮`,
    }))
    const built = buildPrompt(makeHits(1), "问".repeat(LLM_QUESTION_MAX_CHARS + 500), history)
    // 1 system + 最多 20 条历史 + 1 当前问题
    expect(built.messages.length).toBe(1 + LLM_MAX_HISTORY_MESSAGES + 1)
    const user = built.messages[built.messages.length - 1].content
    expect(user.split("【用户问题】\n")[1].length).toBeLessThanOrEqual(LLM_QUESTION_MAX_CHARS)
  })

  it("extractCitationIndices 抽出并去重引用编号", () => {
    expect(extractCitationIndices("结论一 [来源1]，结论二 [来源3][来源1]。")).toEqual([1, 3])
    expect(extractCitationIndices("没有引用")).toEqual([])
  })
})

describe("summarize：换 key 重试 + 用量记账", () => {
  it("第一个 key 401 → 自动换第二个 key 成功，并记录每个 key 的用量", async () => {
    const db = makeDb()
    const attempts: string[] = []
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      attempts.push(init.headers.Authorization.replace("Bearer ", ""))
      bodies.push(JSON.parse(init.body))
      call++
      if (call === 1) {
        return { ok: false, status: 401, text: async () => "unauthorized", json: async () => ({}) } as unknown as Response
      }
      return chatOk("HRT 需要医生指导 [来源1]")
    }) as unknown as typeof fetch

    const env = { LLM_POOL_KEYS: `${KEY_A},${KEY_B}` }
    const out = await summarize(env, db, makeHits(1), "HRT 是什么？", fetchImpl)

    expect(out.text).toBe("HRT 需要医生指导 [来源1]")
    expect(out.model).toBe(LLM_DEFAULT_MODEL)
    expect(out.citations).toHaveLength(1)
    expect(attempts).toEqual([KEY_A, KEY_B])

    // 上游请求体：默认模型 + max_tokens 800 + 非流式
    expect(bodies[0].model).toBe(LLM_DEFAULT_MODEL)
    expect(bodies[0].max_tokens).toBe(LLM_MAX_TOKENS)
    expect(bodies[0].stream).toBe(false)

    // 第一个 key 记失败（冷却 + markFailure），第二个 key 记成功（endpoint="chat"）
    expect(db.failures).toHaveLength(1)
    const ok = db.usage.filter((u) => u.status === "ok")
    expect(ok).toHaveLength(1)
    expect(ok[0].pool).toBe("llm")
    expect(ok[0].endpoint).toBe("chat")
    expect(ok[0].keyRef).toBe("llm-key-1")
    expect(ok[0].tokensIn).toBe(11)
    expect(ok[0].tokensOut).toBe(22)
    // 上游给了 usage → 不标估算
    expect(out.tokens_in).toBe(11)
    expect(out.tokens_out).toBe(22)
    expect(out.estimated).toBe(false)
  })

  it("池全灭（未配置 LLM_POOL_KEYS）→ 抛 llm-unavailable，可识别降级", async () => {
    const db = makeDb()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(summarize({ LLM_POOL_KEYS: "" }, db, makeHits(1), "问题", fetchImpl)).rejects.toMatchObject({
      name: "LLMError",
      code: "llm-unavailable",
      degrade: true,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(LLM_UNAVAILABLE_NOTICE).toBe("AI总结暂不可用")
  })

  it("超时 → 抛 llm-timeout（AbortError 映射），不无限重试", async () => {
    const db = makeDb()
    let calls = 0
    const fetchImpl = (async (_url: string, init: { signal: AbortSignal }) => {
      calls++
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    }) as unknown as typeof fetch

    const err = await summarize(
      { LLM_POOL_KEYS: `${KEY_A},${KEY_B}`, LLM_TIMEOUT_MS: "20" },
      db,
      makeHits(1),
      "问题",
      fetchImpl,
    ).catch((e) => e)

    expect(err).toBeInstanceOf(LLMError)
    expect(err.code).toBe("llm-timeout")
    expect(isLlmUnavailable(err)).toBe(true)
    expect(calls).toBe(2) // 只重试一次（换 key）
  })

  it("上游 400（不可换 key）→ 抛 llm-upstream，且错误信息不含 key", async () => {
    const db = makeDb()
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => `bad request for ${KEY_A} Bearer ${KEY_A}`,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch

    const err = await summarize({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "问题", fetchImpl).catch((e) => e)
    expect(err.code).toBe("llm-upstream")
    expect(err.status).toBe(400)
    expect(err.message).not.toContain(KEY_A)
    expect(err.message).toContain("[redacted]")
  })

  it("上游返回空内容 → llm-empty", async () => {
    const db = makeDb()
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "   " } }] }),
        text: async () => "",
      }) as unknown as Response) as unknown as typeof fetch
    const err = await summarize({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "问题", fetchImpl).catch((e) => e)
    expect(err.code).toBe("llm-empty")
  })

  it("请求体形状：默认关思考链、max_tokens 钳制到 800、enable_thinking 可 omit", async () => {
    const db = makeDb()
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return chatOk("ok [来源1]")
    }) as unknown as typeof fetch

    await summarize({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "q", fetchImpl)
    expect(bodies[0].enable_thinking).toBe(false)
    expect(bodies[0].max_tokens).toBe(LLM_MAX_TOKENS)

    // LLM_MAX_TOKENS 想放大也不许超过硬上限；enable_thinking=omit 时字段不出现
    await summarize(
      { LLM_POOL_KEYS: KEY_A, LLM_MAX_TOKENS: "5000", LLM_ENABLE_THINKING: "omit" },
      db,
      makeHits(1),
      "q",
      fetchImpl,
    )
    expect(bodies[1].max_tokens).toBe(LLM_MAX_TOKENS)
    expect("enable_thinking" in bodies[1]).toBe(false)
  })

  it("上游未返回 usage → 按字符数估算并标 estimated:true", async () => {
    const db = makeDb()
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        // 注意：没有 usage 字段
        json: async () => ({ choices: [{ message: { content: "根据现有片段无法回答 [来源1]" } }] }),
        text: async () => "",
      }) as unknown as Response) as unknown as typeof fetch

    const out = await summarize({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "问题", fetchImpl)
    expect(out.estimated).toBe(true)
    expect(out.tokens_in).toBeGreaterThan(0)
    expect(out.tokens_out).toBeGreaterThan(0)
    // 估算值也照样记账（key_usage 没有 estimated 列，见交付报告）
    const rec = db.usage.find((u) => u.status === "ok")!
    expect(rec.tokensIn).toBe(out.tokens_in)
    expect(rec.tokensOut).toBe(out.tokens_out)
  })

  it("流式消费者提前 break → usage 仍结算（不漏记配额）", async () => {
    const db = makeDb()
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'),
            )
            c.close()
          },
        }),
        text: async () => "",
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch

    const s = streamSummary({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "问题", fetchImpl)
    for await (const chunk of s) {
      expect(chunk).toBe("你好")
      break // 只消费第一块
    }
    const usage = await s.usage
    expect(usage.estimated).toBe(true)
    expect(usage.tokens_out).toBeGreaterThan(0)
  })

  it("流式失败 → usage promise 也 reject 同一个 LLMError", async () => {
    const db = makeDb()
    const s = streamSummary({ LLM_POOL_KEYS: "" }, db, makeHits(1), "问题", (async () => {
      throw new Error("should-not-be-called")
    }) as unknown as typeof fetch)
    const usageRejected = s.usage.then(
      () => null,
      (e: LLMError) => e,
    )
    const iterErr = await (async () => {
      try {
        for await (const chunk of s) void chunk
        return null
      } catch (e) {
        return e as LLMError
      }
    })()
    expect(iterErr?.code).toBe("llm-unavailable")
    expect((await usageRejected)?.code).toBe("llm-unavailable")
  })

  it("默认端点与 env 覆盖都生效", async () => {
    const db = makeDb()
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return chatOk("ok [来源1]")
    }) as unknown as typeof fetch

    await summarize({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "q", fetchImpl)
    await summarize(
      { LLM_POOL_KEYS: KEY_A, LLM_ENDPOINT: "https://api.example.test/v1/chat/completions/", LLM_MODEL: "GLM-4-9B-0414" },
      db,
      makeHits(1),
      "q",
      fetchImpl,
    )
    expect(urls[0]).toBe(LLM_DEFAULT_ENDPOINT)
    expect(urls[1]).toBe("https://api.example.test/v1/chat/completions")
  })
})

describe("SSE 解析与流式总结", () => {
  const stream = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n")

  it("parseSseChunk 解析完整事件流并保留半包尾巴", () => {
    const { events, rest } = parseSseChunk(stream)
    expect(rest).toBe("")
    expect(events.map((e) => e.data)).toEqual([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '{"choices":[{"delta":{"content":"，世界"}}]}',
      "[DONE]",
    ])
    expect(events.map((e) => extractDeltaContent(e.data)).join("")).toBe("你好，世界")

    // 半包：第一次只收到前半段
    const half = stream.slice(0, 40)
    const first = parseSseChunk(half)
    expect(first.rest.length).toBeGreaterThan(0)
    const second = parseSseChunk(first.rest + stream.slice(40))
    expect([...first.events, ...second.events].map((e) => e.data).length).toBe(3)
  })

  it("extractDeltaContent 忽略 [DONE] 与非法 JSON", () => {
    expect(extractDeltaContent("[DONE]")).toBe("")
    expect(extractDeltaContent("not-json")).toBe("")
    expect(extractDeltaContent('{"choices":[{"delta":{"content":"x"}}]}')).toBe("x")
  })

  it("iterateSse 逐事件迭代 ReadableStream<Uint8Array>", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(stream)
        // 故意拆成 3 块，验证跨 chunk 拼接
        c.enqueue(bytes.slice(0, 30))
        c.enqueue(bytes.slice(30, 90))
        c.enqueue(bytes.slice(90))
        c.close()
      },
    })
    const out: string[] = []
    for await (const ev of iterateSse(body)) out.push(extractDeltaContent(ev.data))
    expect(out.filter(Boolean).join("")).toBe("你好，世界")
  })

  it("streamSummary 逐块产出文本并记一次用量（endpoint=chat）", async () => {
    const db = makeDb()
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      const bytes = new TextEncoder().encode(stream)
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response
    }) as unknown as typeof fetch

    const s = streamSummary({ LLM_POOL_KEYS: KEY_A }, db, makeHits(2), "HRT 风险？", fetchImpl)
    expect(s.citations).toHaveLength(2)
    const chunks: string[] = []
    for await (const c of s) chunks.push(c)

    expect(chunks).toEqual(["你好", "，世界"])
    // 流式用量在结束后结算（上游无 usage → 估算）
    const usage = await s.usage
    expect(usage.estimated).toBe(true)
    expect(usage.tokens_out).toBeGreaterThan(0)
    expect(usage.tokens_in).toBeGreaterThan(0)
    expect(bodies[0].stream).toBe(true)
    expect(bodies[0].max_tokens).toBe(LLM_MAX_TOKENS)
    expect(db.usage.filter((u) => u.endpoint === "chat" && u.status === "ok")).toHaveLength(1)
  })

  it("流式池全灭 → 迭代时抛 llm-unavailable（调用方推降级事件）", async () => {
    const db = makeDb()
    const s = streamSummary({ LLM_POOL_KEYS: "" }, db, makeHits(1), "问题", (async () => {
      throw new Error("should-not-be-called")
    }) as unknown as typeof fetch)
    const err = await (async () => {
      try {
        for await (const chunk of s) {
          // 不应产出任何块
          void chunk
        }
        return null
      } catch (e) {
        return e as LLMError
      }
    })()
    expect(err?.code).toBe("llm-unavailable")
  })

  it("流式上游 500（换 key 后仍失败）→ llm-upstream", async () => {
    const db = makeDb()
    const fetchImpl = (async () =>
      ({ ok: false, status: 500, text: async () => `boom ${KEY_A}`, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    const s = streamSummary({ LLM_POOL_KEYS: KEY_A }, db, makeHits(1), "问题", fetchImpl)
    const err = await (async () => {
      try {
        for await (const chunk of s) {
          /* noop */
          void chunk
        }
        return null
      } catch (e) {
        return e as LLMError
      }
    })()
    expect(err?.code).toBe("llm-upstream")
    expect(err?.message).not.toContain(KEY_A)
  })
})

describe("redactSecrets：错误信息脱敏", () => {
  it("抹掉指定 secret、sk- 形态与 Bearer 串", () => {
    const out = redactSecrets(`fail ${KEY_A} sk-abcdef123456 Authorization: Bearer sk-xyz789xyz`, [KEY_A])
    expect(out).not.toContain(KEY_A)
    expect(out).not.toContain("sk-abcdef123456")
    expect(out).not.toContain("sk-xyz789xyz")
    expect(out).toContain("[redacted]")
  })
})

describe("createChatProvider：pool 隔离在 llm 池", () => {
  it("只使用 LLM_POOL_KEYS，且 provider.model 可被 env 覆盖", () => {
    const db = makeDb()
    const { pool, provider } = createChatProvider(
      { LLM_POOL_KEYS: `${KEY_A},${KEY_B}`, EMBED_POOL_KEYS: "embed-x" },
      db,
    )
    expect(pool).toBeInstanceOf(KeyPool)
    expect(pool.keys("llm")).toHaveLength(2)
    expect(pool.keys("embed")).toHaveLength(1)
    expect(provider.model).toBe(LLM_DEFAULT_MODEL)
    const { provider: p2 } = createChatProvider({ LLM_POOL_KEYS: KEY_A, LLM_MODEL: "THUDM/GLM-4-9B-0414" }, db)
    expect(p2.model).toBe("THUDM/GLM-4-9B-0414")
  })
})
