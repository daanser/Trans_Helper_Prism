// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 关键词回退分支 (plan.md §5.4 / tasks.md T1.3)
// M1/T1.3：D1 bigram 真实现。嵌入/上游失败（池全灭/超时/5xx）时自动降级到本分支：
// query 切成 bigram/ASCII 词 → 查 D1 bigram_index 表按 gram 匹配 → 按 path 聚合、命中 gram 数降序取 top。
// 特点：纯 D1、零外部调用、零配额消耗、低延迟、低精度；返回 fallback:true，前端展示 banner。
import type { SearchHit } from "./types"
import { splitBigrams, queryBigrams, rowToHit, type BigramRow } from "./bigram"

/** 回退分支响应体。与完整调用的 SearchResponse 形状不同（无 timings/quota）。 */
export interface FallbackResponse {
  hits: SearchHit[]
  fallback: true
  notice: string
}

/** 回退检索默认返回条数。 */
const DEFAULT_TOP_K = 10

/** 关键词回退真实现：db 缺失时优雅降级返回空 hits + notice（绝不抛错）。 */
export async function runFallback(
  query: string,
  db: D1Database | undefined,
): Promise<FallbackResponse> {
  if (!db) {
    return {
      hits: [],
      fallback: true,
      notice: "关键词模式（D1 未配置，无法检索）",
    }
  }

  // query 为空或不可切 → 直接空结果，不发 SQL。
  const grams = splitBigrams(query ?? "")
  if (grams.length === 0) {
    return {
      hits: [],
      fallback: true,
      notice: "关键词模式（D1 bigram 索引，无可匹配词）",
    }
  }

  try {
    const rows: BigramRow[] = await queryBigrams(db, grams, DEFAULT_TOP_K)
    return {
      hits: rows.map(rowToHit),
      fallback: true,
      notice: "关键词模式（D1 bigram 索引）",
    }
  } catch {
    // D1 查询异常不影响主流程：降级为空结果。
    return {
      hits: [],
      fallback: true,
      notice: "关键词模式（D1 bigram 索引暂不可用）",
    }
  }
}