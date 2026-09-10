// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — D1 schema 语句（从 src/db/schema.sql 派生，供 Worker 内 bootstrap 执行）
//
// 用途：当 wrangler d1 execute 不可用（受限环境）时，可通过
//   POST /api/v1/admin/db/apply-schema   （需 ADMIN_API_KEY）
// 在 Worker 内用 D1 binding 幂等建表。**全部语句均为 IF NOT EXISTS，可重复执行。**
//
// ⚠️ 本文件由 src/db/schema.sql 派生；tests/schemaStatements.test.ts 会校验两者一致，
//    改 schema.sql 后请同步重生成（见该测试的提示）。

/** 幂等 DDL 语句（数组顺序即执行顺序）。 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS accounts ( id TEXT PRIMARY KEY, handle TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' )`,
  `CREATE TABLE IF NOT EXISTS bindings ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, identifier TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0 )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_type_identifier ON bindings (type, identifier)`,
  `CREATE TABLE IF NOT EXISTS quotas ( account_id TEXT PRIMARY KEY, period_start INTEGER NOT NULL, used_cost REAL NOT NULL DEFAULT 0, monthly_limit REAL NOT NULL DEFAULT 5.0, updated_at INTEGER NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS provider_keys ( id TEXT PRIMARY KEY, pool TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'embed', key_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', cooldown_until INTEGER, last_error TEXT, failure_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_pool_ref ON provider_keys (pool, key_ref)`,
  `CREATE TABLE IF NOT EXISTS key_usage ( id TEXT PRIMARY KEY, pool TEXT NOT NULL, key_ref TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT, status TEXT NOT NULL, status_code INTEGER, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_key_usage_key_created ON key_usage (key_ref, created_at)`,
  `CREATE TABLE IF NOT EXISTS ingest_runs ( id TEXT PRIMARY KEY, wiki_id TEXT NOT NULL, commit_sha TEXT, status TEXT NOT NULL, files_added INTEGER NOT NULL DEFAULT 0, files_updated INTEGER NOT NULL DEFAULT 0, files_deleted INTEGER NOT NULL DEFAULT 0, points_upserted INTEGER NOT NULL DEFAULT 0, points_deleted INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, key_ref TEXT, duration_ms INTEGER, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER )`,
  `CREATE TABLE IF NOT EXISTS chat_sessions ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, model_id TEXT NOT NULL, corpora TEXT NOT NULL DEFAULT '[]', round_count INTEGER NOT NULL DEFAULT 0, initial_hits TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS bigram_index ( id TEXT PRIMARY KEY, wiki_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, section TEXT, url TEXT, gram TEXT NOT NULL, snippet TEXT, updated_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_bigram_gram_wiki ON bigram_index (gram, wiki_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bigram_path_wiki ON bigram_index (path, wiki_id)`,
  `CREATE TABLE IF NOT EXISTS ingest_files ( wiki_id TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (wiki_id, path) )`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_files_wiki ON ingest_files (wiki_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log ( id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS custom_models ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, model TEXT NOT NULL, api_key_enc TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_custom_models_account ON custom_models (account_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_sessions_account ON chat_sessions (account_id, updated_at)`,
]
