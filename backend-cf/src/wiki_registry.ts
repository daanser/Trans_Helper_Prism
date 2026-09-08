// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — wiki 配置注册表 + 集合名映射 (tasks.md T2.1 / plan.md §7.2 / §9.3)
// 目标：M2 起新增第 5 个 wiki 只需在 DEFAULT_WIKIS 加一行配置，零代码改动。
// 本模块是 search.ts 的 VALID_CORPORA / collectionName() 的**一致新入口**：
//   同一份 id → Qdrant collection 名（- 换 _ + _v1），绝不改变 search.ts 既有行为。
//   配置字段值以 scripts/one-shot-import.ts（DEFAULT_WIKIS，实际数据管线）与 plan.md §7.2 为准。
// 所有值均为纯静态常量：本模块无网络调用、无 env 依赖（路由/DB/KV 由下一波 captain 接入）。

/**
 * 单个 wiki 源的入库配置（与 one-shot-import.ts 的 WikiConfig 对齐，但按本模块契约字段化）。
 * 字段值基线：
 *   - repo/content_dir：以 one-shot-import.ts `DEFAULT_WIKIS`（数据管线实际值）为准；
 *     content_dir 不同：mtf 只收 zh-cn；ftm 收整个 content；rle/mio 用 docs。
 *   - branch：ingest 时实测默认分支（见 one-shot-import.ts probeDefaultBranch），
 *     此处记录计划默认值（plan.md §7.2 全为 "main"）。
 *   - site_url：原文链接基址，占位为 GitHub blob 链接（与导入器 URL 拼接规则一致）。
 */
export interface WikiConfig {
  id: string
  repo: string
  branch: string
  content_dir: string
  site_url: string
  /** 分块最大字符数（可省略：ingest 侧另有 chunk{maxChars,overlap} 参数，此字段仅为注册表备注项）。 */
  chunk_max_chars?: number
  /** embedding 批次大小（可省略：ingest 侧用 CLI --batch-size，此字段仅为注册表备注项）。 */
  embed_batch_size?: number
}

/** 首批四个 wiki 的白名单配置（tasks.md T0.4 / plan.md §7.1：每库一个 collection）。 */
export const DEFAULT_WIKIS: readonly WikiConfig[] = [
  {
    id: "mtf-wiki",
    repo: "project-trans/MtF-wiki",
    branch: "main",
    content_dir: "content/zh-cn",
    site_url: "https://github.com/project-trans/MtF-wiki/blob/main",
  },
  {
    id: "ftm-wiki",
    repo: "project-trans/FtM-wiki",
    branch: "main",
    content_dir: "content",
    site_url: "https://github.com/project-trans/FtM-wiki/blob/main",
  },
  {
    id: "rle-wiki",
    repo: "project-trans/rle-wiki",
    branch: "main",
    content_dir: "docs",
    site_url: "https://github.com/project-trans/rle-wiki/blob/main",
  },
  {
    id: "miomtfwiki",
    repo: "KitsuMio/MioMtFWiki",
    branch: "main",
    content_dir: "docs",
    site_url: "https://github.com/KitsuMio/MioMtFWiki/blob/main",
  },
] as const

/** 对外白名单：全部已注册 wiki id（与 search.ts VALID_CORPORA 保持一致）。 */
export const VALID_WIKI_IDS: readonly string[] = DEFAULT_WIKIS.map((w) => w.id) as readonly string[]

/**
 * wiki id → Qdrant collection 名：`{id 中 - 换 _}_v1`（如 mtf-wiki → mtf_wiki_v1）。
 * 与 search.ts `collectionName()` 行为完全一致，本模块只提供统一入口，不改动 search.ts。
 */
export function collectionName(wikiId: string): string {
  return `${wikiId.replace(/-/g, "_")}_v1`
}

/** 稳定的 wiki 列表（按 id 字典序，保证确定性排序）。不做原位修改。 */
export function listWikis(): readonly WikiConfig[] {
  return [...DEFAULT_WIKIS].sort((a, b) => a.id.localeCompare(b.id))
}

/** 按 id 取 wiki 配置；未注册返回 undefined。 */
export function getWiki(id: string): WikiConfig | undefined {
  return DEFAULT_WIKIS.find((w) => w.id === id)
}

/** 该 id 是否是已注册 wiki（corpus）白名单成员。 */
export function isValidCorpus(id: string): boolean {
  return VALID_WIKI_IDS.includes(id)
}

// ─────────────────────────────────────────────────────────────
// GET /api/v1/corpora 返回形状（plan.md §9.3）——**只定义类型与数据结构，不接路由**。
// 每库文档数/chunk 数/上次更新时间来自 Qdrant/ingest_runs（下一波 captain 接路由时注入）。
// ─────────────────────────────────────────────────────────────

/** /api/v1/corpora 单库条目。 */
export interface CorpusMeta {
  id: string
  name: string
  site_url: string
  document_count: number
  chunk_count: number
  /** 上次成功 ingest 时间（ISO 8601）；未知为 null。 */
  last_updated: string | null
}

/** /api/v1/corpora 整个响应的数据结构。 */
export interface CorporaResponse {
  corpora: CorpusMeta[]
}

/** 各库展示名（corpora 条目用；注册表配置本身不含 name，避免与管线字段耦合）。 */
export const WIKI_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "mtf-wiki": "MtF Wiki",
  "ftm-wiki": "FtM Wiki",
  "rle-wiki": "RLE Wiki",
  miomtfwiki: "Mio MtF Wiki",
}

/**
 * 由注册表 + 外部统计注入构建 CorporaResponse。
 * stats 可选：注入包含每库 doc/chunk count 与 last_updated 的对象；缺省该库则计数归零、last_updated 为 null。
 * 纯函数、无 I/O——路由层把 Qdrant/D1 统计传进来即可。
 */
export function buildCorporaResponse(
  stats?: ReadonlyMap<string, Pick<CorpusMeta, "document_count" | "chunk_count" | "last_updated">>,
): CorporaResponse {
  const corpora: CorpusMeta[] = listWikis().map((w) => {
    const s = stats?.get(w.id)
    return {
      id: w.id,
      name: WIKI_DISPLAY_NAMES[w.id] ?? w.id,
      site_url: w.site_url,
      document_count: s?.document_count ?? 0,
      chunk_count: s?.chunk_count ?? 0,
      last_updated: s?.last_updated ?? null,
    }
  })
  return { corpora }
}