-- SPDX-License-Identifier: GPL-3.0-or-later
-- TransHelper Prism — D1 schema (v0.1, 骨架版)
-- 依据 plan.md §9.1（DB 用 D1：账号/绑定/配额/key 用量/ingest_runs/chat sessions/bigram 回退索引）。
-- 说明：本文件会被 wrangler d1 migrations apply 执行（具体迁移流程见 T0.1 验收）。
-- 所有表均带注释；索引随查询需求逐步补充（M2 起按 ingest/检索 query 形态加）。

-- ─────────────────────────────────────────────
-- 账号（accounts）：登录主体。X/邮箱绑定分开存，见 bindings。
-- 不做实名/手机；绑定标识落库最小化（X 只存 id+handle hash）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,              -- 内部 UUID（randomUUID）
  handle         TEXT NOT NULL DEFAULT '',      -- 展示名（可空）
  created_at     INTEGER NOT NULL,              -- epoch ms
  status         TEXT NOT NULL DEFAULT 'active' -- active | banned | disabled
);

-- ─────────────────────────────────────────────
-- 绑定（bindings）：登录主体与第三方身份/邮箱的映射，一对多。
-- 隐私：identifier 落库最小化（hash），不存完整邮箱/X token；type 区分 x/email。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bindings (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,                   -- -> accounts.id
  type         TEXT NOT NULL,                   -- x | email
  identifier   TEXT NOT NULL,                   -- 最小化存储（hash of x id / email）
  provider_id  TEXT,                            -- 第三方原始 id（如需，默认最小化）
  created_at   INTEGER NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0       -- 是否已通过验证
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_type_identifier
  ON bindings (type, identifier);

-- ─────────────────────────────────────────────
-- 配额（quotas）：每账号每月的 5h 加权配额。
-- 消耗模型见 plan.md §3.4/§6.2。剩余额 = monthly_limit - used_cost。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotas (
  account_id      TEXT PRIMARY KEY,             -- -> accounts.id
  period_start    INTEGER NOT NULL,             -- 当前计费周期起点（epoch ms，月重置用）
  used_cost       REAL NOT NULL DEFAULT 0,      -- 已消耗的加权"配额小时"（方案A折算）
  monthly_limit   REAL NOT NULL DEFAULT 5.0,    -- 默认每月 5h
  updated_at      INTEGER NOT NULL
);

-- ─────────────────────────────────────────────
-- Key Pool（provider_keys）：硅基流动 key 池。
-- 绝不存明文 key：本表只存 key 的引用名（ref）、所归属池、状态、计量计数。
-- 真实 key 只活在各 Workers secret（EMBED_POOL_KEYS / LLM_POOL_KEYS，逗号分隔）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_keys (
  id            TEXT PRIMARY KEY,
  pool          TEXT NOT NULL,                  -- embed | llm | rerank（rerank 可并入 llm_pool 分开记）
  purpose       TEXT NOT NULL DEFAULT 'embed',  -- embed | llm | rerank（语义用途）
  key_ref       TEXT NOT NULL,                  -- key 的引用名（占位，如 "key-0"；明文 key 绝不落库）
  status        TEXT NOT NULL DEFAULT 'active', -- active | cooling | evicted
  cooldown_until INTEGER,                       -- epoch ms，冷却结束时间（null=未冷却）
  last_error    TEXT,                           -- 最近一次失败原因（泛化，不含 key）
  failure_count INTEGER NOT NULL DEFAULT 0,     -- 连续失败次数
  success_count INTEGER NOT NULL DEFAULT 0,     -- 累计成功次数
  total_cost    REAL NOT NULL DEFAULT 0,        -- 累计折算成本（便于判断该补货）
  enabled       INTEGER NOT NULL DEFAULT 1,     -- 是否上架（admin 热上架/禁用）
  updated_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_pool_ref
  ON provider_keys (pool, key_ref);

-- ─────────────────────────────────────────────
-- Key 用量记账（key_usage）：每次模型调用记录，admin 可查"哪个号烧了多少 / 哪个账号用了多少"。
-- `account_id` 是账号维度归属：发起这次调用的账号（匿名调用记空串 ''，仍照记账）。
-- ⚠️ 历史表补列（SQLite 没有 ADD COLUMN IF NOT EXISTS，CREATE TABLE IF NOT EXISTS 也不会补列）：
--    ALTER TABLE key_usage ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
--    该 ALTER **故意不写在本文件**（会被 schemaStatements 的派生逻辑当成建表语句、破坏"逐条一致"语义），
--    而是由 src/db/schemaStatements.ts 的 SCHEMA_MIGRATIONS 单独导出，并在
--    POST /api/v1/admin/db/apply-schema 里把 "duplicate column name" 视为成功（新库/已迁移）后继续。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS key_usage (
  id            TEXT PRIMARY KEY,
  pool          TEXT NOT NULL,
  key_ref       TEXT NOT NULL,                  -- 与 provider_keys.key_ref 对应
  account_id    TEXT NOT NULL DEFAULT '',       -- 归属账号（'' = 匿名调用）
  endpoint      TEXT NOT NULL,                  -- embeddings | rerank | chat
  model         TEXT,
  status        TEXT NOT NULL,                  -- ok | failed
  status_code   INTEGER,                        -- 上游 HTTP 状态（成功时 200）
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  cost          REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_usage_key_created
  ON key_usage (key_ref, created_at);

-- /admin/usage 按「账号 + 窗口」聚合（requests / llm_tokens_in / llm_tokens_out）走这条索引。
CREATE INDEX IF NOT EXISTS idx_key_usage_account_created
  ON key_usage (account_id, created_at);

-- ─────────────────────────────────────────────
-- 导入运行记录（ingest_runs）：每次 ingest 的元数据（M2 起由 cron/consumer 写入）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            TEXT PRIMARY KEY,
  wiki_id       TEXT NOT NULL,                  -- 集合 / wiki 标识
  commit_sha    TEXT,                           -- 上次成功处理的 commit
  status        TEXT NOT NULL,                  -- started | success | failed | skipped
  files_added   INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  files_deleted INTEGER NOT NULL DEFAULT 0,
  points_upserted INTEGER NOT NULL DEFAULT 0,
  points_deleted  INTEGER NOT NULL DEFAULT 0,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0,
  key_ref       TEXT,                           -- 本次主要消耗的 key（引用名）
  duration_ms   INTEGER,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

-- ─────────────────────────────────────────────
-- 聊天会话（chat_sessions）：LLM 追问多轮上下文（M3/§8.3）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,                  -- -> accounts.id
  model_id      TEXT NOT NULL,                  -- default | 自定义模型 id
  corpora       TEXT NOT NULL DEFAULT '[]',     -- JSON array of corpus ids
  round_count   INTEGER NOT NULL DEFAULT 0,     -- 当前轮数（上限 10 轮，见 §8.4）
  initial_hits  TEXT NOT NULL DEFAULT '[]',     -- 首轮 hits（序号+摘要），作为上下文锚点
  history       TEXT NOT NULL DEFAULT '[]',     -- JSON：最近 N 轮消息（超长截断）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ─────────────────────────────────────────────
-- 结巴回退索引（bigram_index）：ingest 时预计算 bigram，回退分支用（plan.md §5.4）。
-- 回退链路（T1.3）：embedding/Qdrant 全灭 → runFallback(query, DB) 把 query 切成
-- bigram/ASCII 词 → 按 gram 匹配本表 → 按 path 聚合、命中 gram 数降序取 top → 返回 hits。
-- 表较大，后续按 wiki_id+gram 建索引；此处先建骨架。
-- snippet 列在骨架阶段补齐，供回退分支直接带摘要返回（M1 按需加列符合注释约定）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bigram_index (
  id            TEXT PRIMARY KEY,
  wiki_id       TEXT NOT NULL,
  path          TEXT NOT NULL,                  -- 文档路径
  title         TEXT NOT NULL,
  section       TEXT,
  url           TEXT,
  gram          TEXT NOT NULL,                  -- bigram / 关键词 token
  snippet       TEXT,                           -- 摘要片段（回退分支直接带出）
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bigram_gram_wiki
  ON bigram_index (gram, wiki_id);

-- 回退检索时按 gram 匹配文档 id 去重聚合，用 id 关联原始 chunk 信息。
CREATE INDEX IF NOT EXISTS idx_bigram_path_wiki
  ON bigram_index (path, wiki_id);

-- ─────────────────────────────────────────────
-- 增量文件清单（ingest_files）：真·文件级增量（T2.2 真增量版）。
-- 每次 ingest 记录 content_dir 下每个入库文件的路径 + 内容 hash，
-- 下次跑时只对 hash 变化的文件重新 embed/upsert，消失的文件删除（Qdrant points + bigram 行）。
-- 无此表时退化全量重嵌（幂等覆盖），不破坏旧行为。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingest_files (
  wiki_id      TEXT NOT NULL,
  path         TEXT NOT NULL,                  -- repo-root 相对路径（与 Qdrant payload.path 一致）
  content_hash TEXT NOT NULL,                  -- sha1(原始文件内容) hex
  updated_at   INTEGER NOT NULL,               -- epoch ms
  PRIMARY KEY (wiki_id, path)
);

CREATE INDEX IF NOT EXISTS idx_ingest_files_wiki
  ON ingest_files (wiki_id);

-- ─────────────────────────────────────────────
-- 审计日志（audit_log）：敏感操作留痕（封禁/解封、加额/扣额、改模型配置、key 上架禁用等）。
-- 只记 actor/target/动作/泛化 detail，绝不记 key 明文或用户隐私字段（T3.3）。
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,                  -- 操作者 account_id（系统操作为 'system'）
  action      TEXT NOT NULL,                  -- ban | unban | grant_quota | revoke_quota | set_model | key_enable | key_disable ...
  target      TEXT NOT NULL DEFAULT '',       -- 被操作对象（account_id / key_ref / model_id）
  detail      TEXT NOT NULL DEFAULT '',       -- 泛化说明（脱敏，不含 key/隐私）
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON audit_log (actor_id, created_at);

-- ─────────────────────────────────────────────
-- 自定义模型（T3.5，plan.md §8.2）：用户自带 OpenAI-compatible 配置。
-- api_key_enc 为 AES-GCM 密文（v1:base64(iv|cipher)），密钥来自 Workers secret CUSTOM_MODEL_ENC_KEY；
-- 绝不存明文 key。查询一律带 account_id（越权视为不存在）。
-- ─────────────────────────────────────────────
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
  ON custom_models (account_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_account
  ON chat_sessions (account_id, updated_at);
