// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 压测脚本 (tasks.md T1.4)
// 目的：20 个真实 wiki query 对比 rerank 开/关的 P50 与首条相关率，终定 use_reranker 默认开关。
// 复用生产链路 runSearch，跑在 Workers 外调线上 API（与部署同代码路径）。
// key 只从 backend-cf/.dev.vars 读（QDRANT_URL/QDRANT_API_KEY/POOL_KEYS_0…），
// 脚本只打印 状态/延迟/命中相关度，绝不回显 key。
// 用法：npx tsx scripts/bench_search.ts [--reruns N] [--topk K]
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { runSearch } from "../src/search"
import type { RunSearchResult } from "../src/search"
import type { Env } from "../src/types"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 从 .dev.vars 解析 key/URL（只取本脚本所需，绝不含 key 明文输出）。 */
function loadDevVars(): Record<string, string> {
  const raw = readFileSync(join(__dirname, "..", ".dev.vars"), "utf8")
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

/** 真实 query 集（含短词/长句/错别字——T1.4 压测要求）。每条带期望相关关键词（判首条相关用）。 */
const QUERIES: Array<{ q: string; kw: string[] }> = [
  { q: "跨性别", kw: ["跨性别", "transgender"] },
  { q: "激素治疗", kw: ["激素", "estrogen", "雌二醇"] },
  { q: "手术", kw: ["手术", "术"] },
  { q: "自卑", kw: ["自卑", "心理"] },
  { q: "出柜", kw: ["出柜", "come out", "家人"] },
  { q: "HRT 副作用", kw: ["副作用", "肝", "血栓", "乳腺"] },
  { q: "青春期阻断剂", kw: ["阻断", "puberty", "GnRH"] },
  { q: "语音训练", kw: ["语音", "声音", "声带"] },
  { q: "身份证性别变更", kw: ["身份证", "户籍", "性别变更", "性别标记"] },
  { q: "男朋友知道我是跨性别", kw: ["男朋友", "关系", "出柜", "恋爱"] },
  { q: "校园霸凌怎么办", kw: ["霸凌", "校园", "歧视", "安全"] },
  { q: "ftm 胸切除术", kw: ["胸切", "顶部手术", "top surgery", "乳腺"] },
  { q: "rle 长期吃激素", kw: ["激素", "HRT", "用药"] },
  { q: "注射雌二醇", kw: ["注射", "针", "雌二醇"] },
  { q: "复查频率", kw: ["复查", "检查", "化验"] },
  { q: "卡雌二醇", kw: ["卡雌二醇", "cypro", "孕激素", "抗雄"] },
  { q: "睾酮检查", kw: ["睾酮", "检验", "血"] },
  { q: "做完手术后要穿束胸吗", kw: ["束胸", "术后", "恢复"] },
  { q: "激素对我来说安全吗", kw: ["安全", "风险", "禁忌"] },
  { q: "西安能做吗", kw: ["西安", "医院", "地区"] },
]

interface Summary {
  path: string
  samples: number[]
  hitRelevant: boolean[]
}
function summarize(s: Summary): { p50: number; hitRate: number } {
  const ok = s.samples.filter((v) => v > 0).sort((a, b) => a - b)
  const p50 = ok.length ? ok[Math.floor(ok.length / 2)] : -1
  const hitRate = s.hitRelevant.length ? s.hitRelevant.filter(Boolean).length / s.hitRelevant.length : 0
  return { p50, hitRate }
}
function isFallback(r: RunSearchResult): boolean {
  return (r as { fallback?: boolean }).fallback === true
}

async function main(): Promise<void> {
  const dev = loadDevVars()
  const reruns = parseInt(process.argv.find((a) => a.startsWith("--reruns="))?.split("=")[1] ?? "3", 10)
  const topK = parseInt(process.argv.find((a) => a.startsWith("--topk="))?.split("=")[1] ?? "10", 10)
  const corpora = ["mtf-wiki", "ftm-wiki", "rle-wiki", "miomtfwiki"]

  // 密钥：把 .dev.vars 里所有 `POOL_KEYS_<n>` 原样带进 env（扫描/解析交给 src/keypool.ts）
  const poolKeys = Object.fromEntries(Object.entries(dev).filter(([k]) => /^POOL_KEYS_\d+$/.test(k)))
  if (Object.keys(poolKeys).length === 0) {
    throw new Error("缺少密钥：请在 backend-cf/.dev.vars 里配置 POOL_KEYS_0=sk-...（多把再加 POOL_KEYS_1/2…）")
  }

  const env = {
    ...poolKeys,
    QDRANT_URL: dev["QDRANT_URL"],
    QDRANT_API_KEY: dev["QDRANT_API_KEY"],
    EMBEDDING_MODEL: "BAAI/bge-m3",
    EMBEDDING_DIM: "1024",
    RERANK_MODEL: "BAAI/bge-reranker-v2-m3",
    QDRANT_TIMEOUT_MS: "15000",
  } as unknown as Env

  const vec = { path: "vector", samples: [] as number[], hitRelevant: [] as boolean[] }
  const rr = { path: "+rerank", samples: [] as number[], hitRelevant: [] as boolean[] }

  for (const item of QUERIES) {
    for (let path = 0; path < 2; path++) {
      const useReranker = path === 1
      const acc = useReranker ? rr : vec
      let relevant = false
      // reruns 次，串行测延迟（不并发，避免互相干扰）；P50 覆盖全部样本
      for (let i = 0; i < reruns; i++) {
        const t0 = performance.now()
        const res = await runSearch({ query: item.q, corpora, top_k: topK, use_reranker: useReranker }, env)
        const total = Math.round(performance.now() - t0)
        acc.samples.push(total)
        if (i === reruns - 1) {
          // 最后一次取样判首条相关度
          const top = isFallback(res) ? undefined : (res as { hits: Array<{ title: string; snippet: string }> }).hits[0]
          if (top) {
            const text = `${top.title}\n${top.snippet}`
            relevant = item.kw.some((k) => text.toLowerCase().includes(k.toLowerCase()))
          }
        }
      }
      acc.hitRelevant.push(relevant)
    }
  }

  // 汇总
  const vs = summarize(vec)
  const rs = summarize(rr)
  console.log(`\n===== bench_search (reruns=${reruns}, top_k=${topK}, queries=${QUERIES.length}) =====`)
  console.log(`纯向量  : P50=${vs.p50}ms  hit@1=${(vs.hitRate * 100).toFixed(1)}%  (${vec.samples.length} samples)`)
  console.log(`+rerank : P50=${rs.p50}ms  hit@1=${(rs.hitRate * 100).toFixed(1)}%  (${rr.samples.length} samples)`)
  const p50Ratio = rs.p50 > 0 && vs.p50 > 0 ? (rs.p50 / vs.p50).toFixed(2) : "-"
  console.log(`rerank/vector P50 比: ${p50Ratio}`)
  console.log(`\n结论 => vector hit@1=${(vs.hitRate * 100).toFixed(1)}% ; +rerank hit@1=${(rs.hitRate * 100).toFixed(1)}%`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}