// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — T0.0 连通性实测 (plan.md §9.1 / tasks.md T0.0)
// 用途：分别打硅基流动中国站 embeddings / rerank / chat 各一次，记录连通性 + P50 延迟。
//   M0 第一件事：Workers → api.siliconflow.cn 连通实测，不通则全 CF 方案重估。
// 两种运行方式：
//   1) 本地 CLI：先 export SILICONFLOW_API_KEY=sk-xxx 再 `npm run probe`
//   2) 部署为独立 Worker：把本文件作为 main，key 用 wrangler secret 注入 SILICONFLOW_API_KEY
//      —— 访问 `?endpoint=embed|rerank|chat&runs=5` 触发本轮探测并返回 JSON。
// 绝不打印 key；耗时统计用 monotonic 时间。

export interface ProbeResult {
  endpoint: string
  ok: boolean
  status?: number
  latencyMs?: number
  p50Ms?: number
  error?: string
}

export interface ProbeEnv {
  SILICONFLOW_API_KEY?: string
  SILICONFLOW_BASE_URL?: string
}

const BASE_URL = (base?: string) => (base ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "") + "/"

// T0.0 实测修正（2026-09-07）：之前这里用 replace(/\/+$/, "/")，当 base 无结尾斜杠时
//（如默认 ".../v1"）不会补斜杠，导致拼出 ".../v1embeddings" 全员 404。已改为统一去尾斜杠再加一根。

/** 单次探测一个 endpoint，返回连通性 + 本次耗时。 */
export async function probeOnce(
  endpoint: "embed" | "rerank" | "chat",
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    let url = ""
    let body: Record<string, unknown> = {}
    if (endpoint === "embed") {
      url = `${baseUrl}embeddings`
      body = { model: "BAAI/bge-m3", input: "连通性测试 connectivity probe" }
    } else if (endpoint === "rerank") {
      url = `${baseUrl}rerank`
      body = { model: "BAAI/bge-reranker-v2-m3", query: "测试", documents: ["这是一段用于连通性探测的文档。"] }
    } else {
      url = `${baseUrl}chat/completions`
      body = { model: "Qwen/Qwen3-8B", messages: [{ role: "user", content: "ping" }], max_tokens: 8 }
    }
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    })
    const elapsed = Math.round(performance.now() - started)
    const ok = resp.ok
    if (!ok) {
      const text = await resp.text().catch(() => "")
      return { endpoint, ok: false, status: resp.status, latencyMs: elapsed, error: text.slice(0, 300) }
    }
    await resp.text() // 读完 body，等待上游完整返回（衡量完整延迟）
    return { endpoint, ok: true, status: resp.status, latencyMs: elapsed }
  } catch (e) {
    const elapsed = Math.round(performance.now() - started)
    return { endpoint, ok: false, latencyMs: elapsed, error: (e as Error).message ?? String(e) }
  } finally {
    clearTimeout(timeout)
  }
}

/** 跑 N 次取 P50。 */
export async function probeWithP50(
  endpoint: "embed" | "rerank" | "chat",
  baseUrl: string,
  apiKey: string,
  runs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (let i = 0; i < runs; i++) {
    results.push(await probeOnce(endpoint, baseUrl, apiKey, fetchImpl))
  }
  const okLatencies = results.filter((r) => r.ok).map((r) => r.latencyMs ?? 0).sort((a, b) => a - b)
  const p50 = okLatencies.length > 0 ? okLatencies[Math.floor(okLatencies.length / 2)] : undefined
  return results.map((r) => ({ ...r, p50Ms: p50 }))
}

// ── 本地 CLI 入口 ──
async function main(): Promise<void> {
  const apiKey = process.env.SILICONFLOW_API_KEY
  if (!apiKey) {
    console.error("[probe] 需要环境变量 SILICONFLOW_API_KEY（绝不写入仓库）。")
    process.exit(1)
  }
  const runs = parseInt(process.env.PROBE_RUNS ?? "5", 10)
  const base = BASE_URL(process.env.SILICONFLOW_BASE_URL)
  const endpoints: Array<"embed" | "rerank" | "chat"> = ["embed", "rerank", "chat"]
  for (const ep of endpoints) {
    console.log(`\n===== ${ep} (${runs} runs) =====`)
    const res = await probeWithP50(ep, base, apiKey, runs)
    for (const r of res) {
      console.log(`  ${r.ok ? "OK " : "FAIL"} status=${r.status ?? "-"} latency=${r.latencyMs ?? "-"}ms p50=${r.p50Ms ?? "-"}ms ${r.error ?? ""}`)
    }
  }
}

/**
 * 作为独立 Worker 部署时的入口。
 * wrangler secret 注入 SILICONFLOW_API_KEY；访问带 ?endpoint=embed|rerank|chat&runs=N。
 */
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const apiKey = env.SILICONFLOW_API_KEY
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "missing SILICONFLOW_API_KEY secret" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }
    const url = new URL(request.url)
    const endpoint = (url.searchParams.get("endpoint") ?? "embed") as "embed" | "rerank" | "chat"
    const runs = Math.min(Math.max(parseInt(url.searchParams.get("runs") ?? "5", 10) || 5, 1), 20)
    const base = BASE_URL(env.SILICONFLOW_BASE_URL)
    const res = await probeWithP50(endpoint, base, apiKey, runs)
    return new Response(JSON.stringify({ endpoint, runs, results: res }), {
      headers: { "Content-Type": "application/json" },
    })
  },
}

// 本地运行时触发 main（tsx 直接跑本文件作为入口时；被 Worker 打包时不会触发）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
