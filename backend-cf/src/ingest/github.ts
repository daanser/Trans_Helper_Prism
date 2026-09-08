// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — GitHub tarball 增量取数 (tasks.md T2.2 / plan.md §7.3)
// Workers 里不能 git clone，用 GitHub API tarball：拉 branch 的 tar.gz → 自解包 → 定位 content_dir → 取最新 commit sha。
// 实现从 scripts/one-shot-import.ts 的等价逻辑搬过来（downloadTarball/extractTarGz/resolveContentDir/fetchCommitSha），
// 保持一致行为，但**复制**到 ingest 下而非 import：scripts 依赖 node:fs/node:path 且有 CLI 入口副作用，
// 直接 import 会拖入整套 Node 依赖与进程级 side-effect，Workers 环境不干净。
// 本模块仅依赖 node:zlib（gunzipSync，workerd nodejs_compat 支持），其余为纯 fetch/字节运算。
// 所有 GitHub 请求带 15s 超时；非 2xx / 网络错误抛带 status 的 GitHubFetchError，绝不打印 key。
import { gunzipSync } from "node:zlib"

/** GitHub 请求（tarball / API）失败：携带 HTTP status 或 0（网络/超时）。 */
export class GitHubFetchError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "GitHubFetchError"
    this.status = status
  }
}

/** GitHub REST API 请求头（公开仓库无需鉴权，只设 UA/Accept）。 */
const API_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "transhelper-prism-ingest",
}

/** 统一的 15s 超时 fetch 封装：非 2xx 抛带 status 的错误。 */
async function ghFetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!resp.ok) throw new GitHubFetchError(`github-fetch-failed ${url} status=${resp.status}`, resp.status)
    return resp
  } catch (e) {
    if (e instanceof GitHubFetchError) throw e
    // 超时（abort）或网络错误 → status 0
    const aborted = (e as Error)?.name === "AbortError"
    throw new GitHubFetchError(`github-fetch-${aborted ? "timeout" : "network"}: ${(e as Error)?.message ?? ""}`, 0)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 GitHub 拉取 branch 的 tarball 原始字节。非 2xx 抛 GitHubFetchError（status）。
 */
export async function downloadTarball(repo: string, branch: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const url = `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`
  const resp = await ghFetchWithTimeout(url, fetchImpl, { method: "GET" })
  const buf = await resp.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * 极简 tar 解包：返回 文件相对路径 -> utf8 文本 的映射（只保留我们关心的文本条目）。
 * 支持 GNU 长文件名（typeflag 'L'/长链接名 'K'）：其 data 块存储真实 name，
 * 下一个条目应用它为 name。若路径超 ustar 100(+155 prefix) 限制（如 MtF 108 字符路径），
 * GNU tar 会用 'L' 条目，跳过会导致整条目录丢失。此处显式解析并应用。
 * 与 scripts/one-shot-import.ts extractTarGz 行为一致。
 */
export function extractTarGz(buf: Uint8Array): Record<string, string> {
  const raw = gunzipSync(buf)
  const files: Record<string, string> = {}
  const decoder = new TextDecoder("utf-8")
  let offset = 0
  // GNU 'L'/'K' 条目：其 data 块存真实长 name（或 linkname），应用到下一个条目
  let pendingLongName: string | null = null

  const readString = (start: number, len: number): string => {
    const bytes = raw.subarray(start, start + len)
    let end = 0
    while (end < bytes.length && bytes[end] !== 0) end++
    return decoder.decode(bytes.subarray(0, end))
  }

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // 全零块：tar 结束
    if (header.every((b) => b === 0)) break

    let name = readString(offset, 100)
    const sizeStr = readString(offset + 124, 12).trim()
    const typeflag = String.fromCharCode(raw[offset + 156])
    const prefix = readString(offset + 345, 155)

    if (prefix) name = `${prefix}/${name}`

    const size = sizeStr ? parseInt(sizeStr, 8) : 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const data = raw.subarray(dataStart, dataEnd)

    if (typeflag === "L" || typeflag === "K") {
      // GNU 长名/长链接名：data 块（连同结尾 NUL/换行）是真实 name，保存给下一个条目
      pendingLongName = decoder.decode(data).replace(/\0+$/, "").replace(/\n$/, "").trim()
    } else {
      // 正规文件（typeflag 0 或 '0' 或空）才取内容；长名条目已修正 name
      if ((typeflag === "0" || typeflag === "\x00" || typeflag === "") && size >= 0) {
        const effectiveName = pendingLongName ?? name
        files[effectiveName] = decoder.decode(data)
      }
      pendingLongName = null // 长名只作用于紧随其后的一个条目
    }

    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

/** 去掉 tarball 顶层 {repo}-{branch} 目录，得到 repo-root-relative 树。 */
export function stripTopDir(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tree)) {
    const parts = k.split("/").filter(Boolean)
    out[parts.slice(1).join("/")] = v
  }
  return out
}

/**
 * 从"repo-root-relative"文件树里找到实际 content 根目录（自适应 content_dir）。
 * 调用方需先确保 tree 的 key 已去掉顶层 `{repo}-{branch}`（tarball 路径）或本身即 repo 根（local 路径）。
 * 不存在时抛带 status 405 的错误（语义：配置错误，非上游问题）。
 */
export function resolveContentDir(tree: Record<string, string>, prefer: string): string {
  const pref = prefer.replace(/^\/+|\/+$/g, "")
  if (Object.keys(tree).some((k) => k.startsWith(pref + "/") || k === pref)) return pref

  const topLevels = new Set<string>()
  for (const k of Object.keys(tree)) {
    const first = k.split("/").filter(Boolean)[0]
    if (first) topLevels.add(first)
  }
  const secondLevels = new Set<string>()
  for (const k of Object.keys(tree)) {
    const parts = k.split("/").filter(Boolean)
    if (parts.length >= 2) secondLevels.add(`${parts[0]}/${parts[1]}`)
  }
  throw new GitHubFetchError(
    `content_dir "${prefer}" 不存在。库内可用顶层目录：${[...topLevels].join(", ") || "(空)"}；` +
      `二级：${[...secondLevels].join(", ") || "(无)"}。请检查 content_dir 配置。`,
    405,
  )
}

/**
 * 拿到仓库默认分支上某个 commit sha（用于记录到 chunk / ingest_runs）。
 * 失败返回空串（不阻塞主流程；下轮 diff 仍以内容去重为准）。
 */
export async function fetchCommitSha(repo: string, branch: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const resp = await ghFetchWithTimeout(`https://api.github.com/repos/${repo}/commits/${branch}`, fetchImpl, {
      headers: API_HEADERS,
    })
    const j = (await resp.json()) as { sha?: string }
    return j.sha ?? ""
  } catch {
    // 拿不到 sha 不致命：返回空串，调用方记录 commitsha 为空 / "unknown"
    return ""
  }
}

/**
 * 取 content_dir 子树内所有 .md 文件（repo-root 相对路径 → 内容），天然排除静态资产/其它语言/主题。
 * 与 one-shot-import.ts 的取子集逻辑一致。返回条目带 repo-root 路径、content-dir 相对路径。
 */
export function collectMarkdown(
  tree: Record<string, string>,
  contentDir: string,
): Array<{ repoRootPath: string; contentDirRel: string; content: string }> {
  const prefix = contentDir ? `${contentDir}/` : ""
  const out: Array<{ repoRootPath: string; contentDirRel: string; content: string }> = []
  for (const [repoRootPath, content] of Object.entries(tree)) {
    if (repoRootPath === contentDir || repoRootPath.startsWith(prefix)) {
      if (repoRootPath.split("/").pop()?.toLowerCase().endsWith(".md")) {
        out.push({ repoRootPath, contentDirRel: repoRootPath.slice(prefix.length), content })
      }
    }
  }
  return out.sort((a, b) => a.repoRootPath.localeCompare(b.repoRootPath))
}