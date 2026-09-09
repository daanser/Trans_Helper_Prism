// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 用户自定义模型（plan.md §8.2，tasks.md T3.5）
//
// 定位：让用户在 `/settings` 填自己的 OpenAI-compatible 配置（base_url + api_key + model）作为逃生通道，
// 后端代调、只用于本人请求。本模块负责：
//   1. **api_key 加密落库**：WebCrypto AES-GCM（随机 12 字节 IV），密钥来自 env `CUSTOM_MODEL_ENC_KEY`；
//      缺失/过短 → 抛可识别配置错误，**绝不落明文、绝不打印 key**；
//   2. **配置校验 + SSRF 防护**：只允许 https、拒绝内网/回环/链路本地/CGNAT/元数据地址与单标签主机名；
//   3. **OpenAI 兼容调用**：错误信息脱敏（永不回显 key），超时可配。
//
// 存储：D1 `custom_models` 表（本文件不改 schema.sql，DDL 见导出常量 `CUSTOM_MODEL_DDL`，需由 captain 应用）。
// 密文格式：`v1:<base64(iv(12) | ciphertext+tag)>`；`v1:` 前缀便于将来轮换算法/密钥而不破坏旧行。

import type { ChatMessage } from "./llm"
import { redactSecrets } from "./llm"
import { defaultFetch, estimateTokens } from "./embeddings"

/**
 * 加密相关 env 子集。`types.ts` 的 `Env` 尚未声明 `CUSTOM_MODEL_ENC_KEY`（弱类型检查会拦下
 * 全可选属性的形参），故对外函数参数收 `unknown` 再内部收窄；补进 `Env` 后可收紧签名。
 */
export interface CustomModelEnv {
  CUSTOM_MODEL_ENC_KEY?: string
}

/** 把 `c.env`（或任意 env 形状）收窄成 CustomModelEnv。 */
export function asCustomModelEnv(env: unknown): CustomModelEnv {
  return (env ?? {}) as CustomModelEnv
}

/** 加密密钥的 env 变量名（Workers secret）。 */
export const CUSTOM_MODEL_ENC_KEY_ENV = "CUSTOM_MODEL_ENC_KEY"
/** AES-GCM IV 长度（字节）。 */
export const CUSTOM_MODEL_IV_BYTES = 12
/** 密文前缀（版本号，便于将来轮换）。 */
export const CUSTOM_MODEL_CIPHER_PREFIX = "v1:"
/** 自定义模型调用默认超时（毫秒）。 */
export const CUSTOM_MODEL_DEFAULT_TIMEOUT_MS = 20_000
/** base_url 长度上限。 */
export const CUSTOM_MODEL_MAX_BASE_URL = 512
/** model 名称长度上限。 */
export const CUSTOM_MODEL_MAX_MODEL = 200
/** api_key 长度上限。 */
export const CUSTOM_MODEL_MAX_API_KEY = 512
/** 名称（用户可见标签）长度上限。 */
export const CUSTOM_MODEL_MAX_NAME = 60

/**
 * D1 DDL：**不要写进 schema.sql**（文件所有权约束）。captain 应用迁移时执行这段。
 * 注意：api_key_enc 只存密文，永不存明文。
 */
export const CUSTOM_MODEL_DDL = `-- 自定义模型（T3.5，plan.md §8.2）：用户自带 OpenAI-compatible 配置
-- api_key_enc 为 AES-GCM 密文（v1:base64(iv|cipher)），密钥来自 Workers secret CUSTOM_MODEL_ENC_KEY
CREATE TABLE IF NOT EXISTS custom_models (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,                  -- -> accounts.id
  name        TEXT NOT NULL DEFAULT '',       -- 用户可见标签
  base_url    TEXT NOT NULL,                  -- https://…（已过 SSRF 校验）
  model       TEXT NOT NULL,                  -- 上游模型名
  api_key_enc TEXT NOT NULL,                  -- 密文，绝不存明文
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_models_account
  ON custom_models (account_id, updated_at);`

/** 可识别配置/调用错误码。 */
export type CustomModelErrorCode =
  | "enc-key-missing"
  | "enc-key-invalid"
  | "invalid-base-url"
  | "insecure-base-url"
  | "blocked-host"
  | "invalid-model"
  | "decrypt-failed"
  | "custom-model-timeout"
  | "custom-model-http"
  | "custom-model-empty"

/** 配置/调用错误。message 已脱敏，绝不含 api_key。 */
export class CustomModelError extends Error {
  readonly code: CustomModelErrorCode
  readonly status?: number
  constructor(code: CustomModelErrorCode, message: string, status?: number) {
    super(message)
    this.name = "CustomModelError"
    this.code = code
    this.status = status
  }
}

/** 用户填写的原始配置。 */
export interface CustomModelInput {
  base_url: string
  model: string
  /** 明文 key（只在内存中出现，落库前必加密） */
  api_key?: string
  name?: string
}

/** 调用用配置（api_key 为解密后的明文，只活在一次请求内）。 */
export interface CustomModelConfig {
  base_url: string
  model: string
  api_key: string
}

/** 对外返回（永不含 api_key 明文或密文）。 */
export interface CustomModelPublic {
  id: string
  name: string
  base_url: string
  model: string
  /** 脱敏展示，如 `***abcd` */
  api_key_masked: string
  created_at: number
  updated_at: number
}

/** 校验结果。 */
export type ValidateModelConfigResult =
  | { ok: true; base_url: string }
  | { ok: false; code: CustomModelErrorCode; reason: string }

// ─────────────────────────────────────────────
// base64（自实现，避免依赖 atob/btoa 的运行时差异）
// ─────────────────────────────────────────────

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Uint8Array → base64（无换行）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/** base64 → Uint8Array；非法输入返回 null（调用方按解密失败处理）。 */
export function base64ToBytes(s: string): Uint8Array | null {
  const clean = (s ?? "").replace(/[\s=]/g, "")
  if (clean.length === 0) return new Uint8Array(0)
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const idx = B64_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ─────────────────────────────────────────────
// 加密 / 解密（WebCrypto AES-GCM）
// ─────────────────────────────────────────────

/** 取 WebCrypto（workerd 与 Node 均有全局 crypto）。 */
function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) throw new CustomModelError("enc-key-invalid", "webcrypto-unavailable")
  return c
}

/**
 * 从 env 导入 AES-256-GCM 密钥：
 *   - `CUSTOM_MODEL_ENC_KEY` 为 base64 且解出恰好 32 字节 → 直接用；
 *   - 否则对 UTF-8 原文做 SHA-256 派生（要求 ≥ 16 字符，否则报错）；
 *   - 缺失 → `enc-key-missing`（调用方返回 503 配置错误，**绝不退化为明文存储**）。
 */
async function importEncKey(env: unknown): Promise<CryptoKey> {
  const raw = asCustomModelEnv(env).CUSTOM_MODEL_ENC_KEY?.trim()
  if (!raw) {
    throw new CustomModelError("enc-key-missing", `${CUSTOM_MODEL_ENC_KEY_ENV}-missing`)
  }
  const c = getCrypto()
  let keyBytes: Uint8Array | null = null
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) {
    const decoded = base64ToBytes(raw)
    if (decoded && decoded.length === 32) keyBytes = decoded
  }
  if (!keyBytes) {
    if (raw.length < 16) {
      throw new CustomModelError("enc-key-invalid", `${CUSTOM_MODEL_ENC_KEY_ENV}-too-short`)
    }
    const digest = await c.subtle.digest("SHA-256", new TextEncoder().encode(raw))
    keyBytes = new Uint8Array(digest)
  }
  return c.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

/**
 * 加密 api_key → `v1:base64(iv|cipher)`。随机 IV，同一明文两次结果不同。
 * 空字符串抛 `invalid-model`（不静默存空 key）。
 */
export async function encryptApiKey(env: unknown, plain: string): Promise<string> {
  const text = (plain ?? "").trim()
  if (!text) throw new CustomModelError("invalid-model", "api-key-empty")
  if (text.length > CUSTOM_MODEL_MAX_API_KEY) throw new CustomModelError("invalid-model", "api-key-too-long")
  const key = await importEncKey(env)
  const c = getCrypto()
  const iv = c.getRandomValues(new Uint8Array(CUSTOM_MODEL_IV_BYTES))
  const cipher = new Uint8Array(
    await c.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)),
  )
  const blob = new Uint8Array(iv.length + cipher.length)
  blob.set(iv, 0)
  blob.set(cipher, iv.length)
  return CUSTOM_MODEL_CIPHER_PREFIX + bytesToBase64(blob)
}

/** 解密 `v1:base64(iv|cipher)` → 明文。任何失败抛 `decrypt-failed`（不含密文内容）。 */
export async function decryptApiKey(env: unknown, blob: string): Promise<string> {
  // 先查部署配置（缺密钥是配置错误，优先级高于密文本身的问题）。
  const key = await importEncKey(env)
  if (!blob || !blob.startsWith(CUSTOM_MODEL_CIPHER_PREFIX)) {
    throw new CustomModelError("decrypt-failed", "cipher-format-invalid")
  }
  const bytes = base64ToBytes(blob.slice(CUSTOM_MODEL_CIPHER_PREFIX.length))
  if (!bytes || bytes.length <= CUSTOM_MODEL_IV_BYTES) {
    throw new CustomModelError("decrypt-failed", "cipher-format-invalid")
  }
  const c = getCrypto()
  const iv = bytes.slice(0, CUSTOM_MODEL_IV_BYTES)
  const data = bytes.slice(CUSTOM_MODEL_IV_BYTES)
  try {
    const plain = await c.subtle.decrypt({ name: "AES-GCM", iv }, key, data)
    return new TextDecoder().decode(plain)
  } catch {
    throw new CustomModelError("decrypt-failed", "decrypt-failed")
  }
}

/** 脱敏展示：保留最后 4 位（不足则全遮）。 */
export function maskApiKey(plain: string | undefined): string {
  const s = (plain ?? "").trim()
  if (!s) return ""
  return s.length <= 4 ? "****" : `****${s.slice(-4)}`
}

// ─────────────────────────────────────────────
// 校验 + SSRF 防护
// ─────────────────────────────────────────────

/** 内网/保留网段判定（IPv4）。 */
function isBlockedIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  const parts = host.split(".").map((p) => parseInt(p, 10))
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // 链路本地 / 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播/保留
  return false
}

/** 内网/保留地址判定（IPv6 字面量，已去方括号）。 */
function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "::1" || h === "::") return true
  if (h.startsWith("fe80")) return true // 链路本地
  if (h.startsWith("fc") || h.startsWith("fd")) return true // ULA
  if (h.startsWith("::ffff:")) {
    // IPv4-mapped：取冒号后段再判
    const mapped = h.slice("::ffff:".length)
    return isBlockedIpv4(mapped) || mapped === "localhost"
  }
  return false
}

/**
 * 主机名是否被 SSRF 防护拒绝（导出便于单测）。
 * 拒绝：localhost/*.localhost/*.local/*.internal、内网/回环/链路本地/CGNAT/组播 IP、
 * 十进制整数 IP（如 2130706433）、单标签主机名（无点，通常是内网名）。
 */
export function isBlockedHost(hostname: string): boolean {
  const host = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!host) return true
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true
  if (host.includes(":")) return isBlockedIpv6(host)
  if (/^\d+$/.test(host)) return true // 十进制整数形式的 IPv4
  if (isBlockedIpv4(host)) return true
  if (!host.includes(".")) return true // 单标签主机名
  return false
}

/**
 * 校验用户自定义模型配置（plan.md §8.2 / tasks.md T3.5）。
 * 只允许 `https://`；拒绝内网/回环地址；model 非空且有长度上限。
 */
export function validateModelConfig(cfg: { base_url?: string; model?: string }): ValidateModelConfigResult {
  const rawBase = (cfg?.base_url ?? "").trim()
  const model = (cfg?.model ?? "").trim()

  if (!rawBase) return { ok: false, code: "invalid-base-url", reason: "base-url-required" }
  if (rawBase.length > CUSTOM_MODEL_MAX_BASE_URL) {
    return { ok: false, code: "invalid-base-url", reason: "base-url-too-long" }
  }
  let url: URL
  try {
    url = new URL(rawBase)
  } catch {
    return { ok: false, code: "invalid-base-url", reason: "base-url-invalid" }
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: "insecure-base-url", reason: "base-url-must-be-https" }
  }
  if (url.username || url.password) {
    return { ok: false, code: "invalid-base-url", reason: "base-url-userinfo-not-allowed" }
  }
  if (url.search || url.hash) {
    return { ok: false, code: "invalid-base-url", reason: "base-url-query-not-allowed" }
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, code: "blocked-host", reason: "base-url-host-not-allowed" }
  }
  if (!model) return { ok: false, code: "invalid-model", reason: "model-required" }
  if (model.length > CUSTOM_MODEL_MAX_MODEL) return { ok: false, code: "invalid-model", reason: "model-too-long" }

  // 规范化：去尾斜杠，保证后续拼接 /chat/completions 不出现双斜杠。
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "")
  return { ok: true, base_url: base }
}

/** base_url → chat/completions 端点（已含则原样返回）。 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "")
  if (/\/chat\/completions$/.test(base)) return base
  return `${base}/chat/completions`
}

// ─────────────────────────────────────────────
// 调用（OpenAI 兼容）
// ─────────────────────────────────────────────

/**
 * 调用结果（token 用量形状与 llm.ts 对齐，供 T3.2 配额扣减）。
 * `estimated=true` 表示上游未返回 usage，按字符数估算。
 */
export interface CustomModelResult {
  text: string
  model: string
  tokens_in: number
  tokens_out: number
  estimated: boolean
  latencyMs: number
}

/** 调用选项。 */
export interface CustomModelCallOptions {
  timeoutMs?: number
  maxTokens?: number
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 调用户自定义模型（OpenAI 兼容 chat/completions）。
 * 安全：错误信息**绝不含 api_key**（先按 key 精确替换，再按 `sk-…`/`Bearer …` 形态兜底脱敏）。
 */
export async function callCustomModel(
  cfg: CustomModelConfig,
  messages: readonly ChatMessage[],
  fetchImpl: typeof fetch = defaultFetch,
  opts: CustomModelCallOptions = {},
): Promise<CustomModelResult> {
  const check = validateModelConfig({ base_url: cfg?.base_url, model: cfg?.model })
  if (!check.ok) throw new CustomModelError(check.code, check.reason)
  const apiKey = (cfg?.api_key ?? "").trim()
  if (!apiKey) throw new CustomModelError("invalid-model", "api-key-empty")

  const endpoint = resolveChatCompletionsUrl(check.base_url)
  const timeoutMs = opts.timeoutMs ?? CUSTOM_MODEL_DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    let resp: Response
    try {
      resp = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: opts.maxTokens ?? 800,
          stream: false,
        }),
      })
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if ((e as Error)?.name === "AbortError" || /abort|timeout|timed out/i.test(msg)) {
        throw new CustomModelError("custom-model-timeout", "custom-model-timeout")
      }
      throw new CustomModelError("custom-model-http", `custom-model-network: ${redactSecrets(msg, [apiKey])}`)
    }

    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")) || ""
      // 关键：上游回显的 body 可能含 key，必须脱敏后才进错误信息。
      throw new CustomModelError(
        "custom-model-http",
        `custom-model-http status=${resp.status} detail=${redactSecrets(detail, [apiKey])}`,
        resp.status,
      )
    }

    const data = (await resp.json()) as ChatCompletionResponse
    const text = (data?.choices?.[0]?.message?.content ?? "").trim()
    if (!text) throw new CustomModelError("custom-model-empty", "custom-model-empty-response")
    const usage = data?.usage
      ? {
          tokens_in: data.usage.prompt_tokens ?? 0,
          tokens_out: data.usage.completion_tokens ?? 0,
          estimated: false,
        }
      : {
          tokens_in: estimateTokens(messages.map((m) => m.content)),
          tokens_out: estimateTokens([text]),
          estimated: true,
        }
    return {
      text,
      model: cfg.model,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      estimated: usage.estimated,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────
// 落库（D1 custom_models，DDL 见 CUSTOM_MODEL_DDL）
// ─────────────────────────────────────────────

/** D1 预处理语句的最小形状（与 chat.ts 同风格，便于 mock）。 */
export interface CustomModelStmt {
  bind(...values: unknown[]): CustomModelStmt
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results?: T[] } | null>
  run(): Promise<unknown>
}

/** D1 绑定的最小形状。 */
export interface CustomModelDb {
  prepare(sql: string): CustomModelStmt
}

interface CustomModelRow {
  id: string
  account_id: string
  name: string
  base_url: string
  model: string
  api_key_enc: string
  created_at: number
  updated_at: number
}

/** 保存/读取结果。 */
export type SaveCustomModelResult =
  | { ok: true; model: CustomModelPublic }
  | { ok: false; code: CustomModelErrorCode | "db-unavailable" | "not-found"; reason: string }

export type LoadCustomModelResult =
  | { ok: true; config: CustomModelConfig; model: CustomModelPublic }
  | { ok: false; code: CustomModelErrorCode | "db-unavailable" | "not-found"; reason: string }

/**
 * 新增/更新用户自定义模型（api_key 加密落库）。
 * `id` 缺省为新建；给了 id 则只更新属于该 account 的行。
 */
export async function saveCustomModel(
  db: CustomModelDb | null | undefined,
  env: unknown,
  accountId: string,
  input: CustomModelInput,
  nowMs: number,
  id?: string,
): Promise<SaveCustomModelResult> {
  if (!db) return { ok: false, code: "db-unavailable", reason: "db-unavailable" }
  if (!accountId) return { ok: false, code: "db-unavailable", reason: "account-required" }

  const check = validateModelConfig({ base_url: input?.base_url, model: input?.model })
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason }

  const name = (input?.name ?? "").trim().slice(0, CUSTOM_MODEL_MAX_NAME)
  const plainKey = (input?.api_key ?? "").trim()

  let encrypted: string
  try {
    if (plainKey) {
      encrypted = await encryptApiKey(env, plainKey)
    } else if (id) {
      // 更新时不改 key：复用旧密文。
      const existing = await db
        .prepare("SELECT api_key_enc FROM custom_models WHERE id = ? AND account_id = ?")
        .bind(id, accountId)
        .first<{ api_key_enc: string }>()
      if (!existing?.api_key_enc) return { ok: false, code: "not-found", reason: "not-found" }
      encrypted = existing.api_key_enc
    } else {
      return { ok: false, code: "invalid-model", reason: "api-key-required" }
    }
  } catch (e) {
    const err = e as CustomModelError
    return { ok: false, code: err.code ?? "enc-key-invalid", reason: err.message ?? "encrypt-failed" }
  }

  const rowId = id ?? crypto.randomUUID()
  try {
    if (id) {
      await db
        .prepare("UPDATE custom_models SET name = ?, base_url = ?, model = ?, api_key_enc = ?, updated_at = ? WHERE id = ? AND account_id = ?")
        .bind(name, check.base_url, input.model.trim(), encrypted, nowMs, id, accountId)
        .run()
    } else {
      await db
        .prepare(
          "INSERT INTO custom_models (id, account_id, name, base_url, model, api_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(rowId, accountId, name, check.base_url, input.model.trim(), encrypted, nowMs, nowMs)
        .run()
    }
  } catch {
    return { ok: false, code: "db-unavailable", reason: "db-write-failed" }
  }

  return {
    ok: true,
    model: {
      id: rowId,
      name,
      base_url: check.base_url,
      model: input.model.trim(),
      api_key_masked: maskApiKey(plainKey) || "****",
      created_at: nowMs,
      updated_at: nowMs,
    },
  }
}

/** 列表项（不含任何 key 信息，只标"已配置"）。 */
export interface CustomModelListItem {
  id: string
  name: string
  base_url: string
  model: string
  /** 恒为 true（本表只存密文，读不出明文；此处只表示"已配置过 key"） */
  key_configured: true
  created_at: number
  updated_at: number
}

/** 列出某用户的自定义模型（只回元信息，绝不回 key 明文/密文；缺 D1 返回空数组）。 */
export async function listCustomModels(
  db: CustomModelDb | null | undefined,
  accountId: string,
): Promise<CustomModelListItem[]> {
  if (!db || !accountId) return []
  try {
    const res = await db
      .prepare(
        "SELECT id, account_id, name, base_url, model, api_key_enc, created_at, updated_at FROM custom_models WHERE account_id = ? ORDER BY updated_at DESC",
      )
      .bind(accountId)
      .all<CustomModelRow>()
    return (res?.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      base_url: row.base_url,
      model: row.model,
      key_configured: true as const,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
  } catch {
    return []
  }
}

/** 读取并解密某用户的某个自定义模型配置（只允许本人：WHERE 带 account_id）。 */
export async function loadCustomModel(
  db: CustomModelDb | null | undefined,
  env: unknown,
  accountId: string,
  modelId: string,
): Promise<LoadCustomModelResult> {
  if (!db) return { ok: false, code: "db-unavailable", reason: "db-unavailable" }
  if (!accountId || !modelId) return { ok: false, code: "not-found", reason: "not-found" }

  let row: CustomModelRow | null = null
  try {
    row = await db
      .prepare(
        "SELECT id, account_id, name, base_url, model, api_key_enc, created_at, updated_at FROM custom_models WHERE id = ? AND account_id = ?",
      )
      .bind(modelId, accountId)
      .first<CustomModelRow>()
  } catch {
    return { ok: false, code: "db-unavailable", reason: "db-read-failed" }
  }
  if (!row) return { ok: false, code: "not-found", reason: "not-found" }

  let apiKey: string
  try {
    apiKey = await decryptApiKey(env, row.api_key_enc)
  } catch (e) {
    const err = e as CustomModelError
    return { ok: false, code: err.code ?? "decrypt-failed", reason: err.message ?? "decrypt-failed" }
  }

  return {
    ok: true,
    config: { base_url: row.base_url, model: row.model, api_key: apiKey },
    model: {
      id: row.id,
      name: row.name,
      base_url: row.base_url,
      model: row.model,
      api_key_masked: maskApiKey(apiKey),
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }
}
