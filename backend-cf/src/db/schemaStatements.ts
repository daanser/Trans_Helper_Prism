// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — D1 schema 语句（从 src/db/schema.sql 派生，供 Worker 内 bootstrap 执行）
//
// 用途：当 wrangler d1 execute 不可用（受限环境）时，可通过
//   POST /api/v1/admin/db/apply-schema   （需 ADMIN_API_KEY）
// 在 Worker 内用 D1 binding 幂等建表。**全部语句均为 IF NOT EXISTS，可重复执行。**
//
// ⚠️ 本文件由 src/db/schema.sql 派生；tests/schemaStatements.test.ts 会校验两者一致，
//    改 schema.sql 后请同步重生成（见该测试的提示）。
//
// ── 为什么另有 SCHEMA_MIGRATIONS ──
// SQLite **没有** `ADD COLUMN IF NOT EXISTS`，`CREATE TABLE IF NOT EXISTS key_usage (...)` 对**已存在**的表
// 是空操作，因此线上老表不会因为改了 schema.sql 就长出 `account_id` 列。
// 补列只能靠 `ALTER TABLE ... ADD COLUMN`，而它天然不幂等（列已在 → duplicate column name；
// 表还不存在 → no such table，后者在全新库上必然发生，因为迁移先跑、建表后跑）。
// 所以：**建表语句与迁移语句分开导出**，由 apply-schema 按「迁移先跑 → 再跑建表」的顺序执行，
// 并用 `isToleratedSchemaError()` 把这两种"已经是对的"错误视为成功（其余错误仍计入 failed）。

/** 幂等 DDL 语句（数组顺序即执行顺序）。 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS accounts ( id TEXT PRIMARY KEY, handle TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' )`,
  `CREATE TABLE IF NOT EXISTS bindings ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, identifier TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0 )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_type_identifier ON bindings (type, identifier)`,
  `CREATE TABLE IF NOT EXISTS quotas ( account_id TEXT PRIMARY KEY, period_start INTEGER NOT NULL, used_cost REAL NOT NULL DEFAULT 0, monthly_limit REAL NOT NULL DEFAULT 5.0, requests INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS provider_keys ( id TEXT PRIMARY KEY, pool TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'embed', key_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', cooldown_until INTEGER, last_error TEXT, failure_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_pool_ref ON provider_keys (pool, key_ref)`,
  `CREATE TABLE IF NOT EXISTS key_usage ( id TEXT PRIMARY KEY, pool TEXT NOT NULL, key_ref TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL, model TEXT, status TEXT NOT NULL, status_code INTEGER, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_key_usage_key_created ON key_usage (key_ref, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_key_usage_account_created ON key_usage (account_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ingest_runs ( id TEXT PRIMARY KEY, wiki_id TEXT NOT NULL, commit_sha TEXT, status TEXT NOT NULL, files_added INTEGER NOT NULL DEFAULT 0, files_updated INTEGER NOT NULL DEFAULT 0, files_deleted INTEGER NOT NULL DEFAULT 0, points_upserted INTEGER NOT NULL DEFAULT 0, points_deleted INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, key_ref TEXT, duration_ms INTEGER, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER )`,
  `CREATE TABLE IF NOT EXISTS chat_sessions ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, model_id TEXT NOT NULL, corpora TEXT NOT NULL DEFAULT '[]', round_count INTEGER NOT NULL DEFAULT 0, initial_hits TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS ingest_files ( wiki_id TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL, blob_sha TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (wiki_id, path) )`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_files_wiki ON ingest_files (wiki_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log ( id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS custom_models ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, model TEXT NOT NULL, api_key_enc TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_custom_models_account ON custom_models (account_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_sessions_account ON chat_sessions (account_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS rate_counters ( bucket_key TEXT PRIMARY KEY, tier TEXT NOT NULL, window_start INTEGER NOT NULL, window_sec INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters (window_start)`,
]

/**
 * 历史表变更的迁移语句（**先于 SCHEMA_STATEMENTS 执行**）。
 *
 * 为什么单独导出、不放进 schema.sql：
 *   schema.sql 只描述**目标形状**（新库一次建对），里面的每一条都会被派生测试断言为
 *   `CREATE ... IF NOT EXISTS` 的幂等语句；而补列 / 删表语句天然不是"建表形状"，混进去会让
 *   "逐条一致"含义失真（也可能被基线与线上不一致的库执行出意外结果）。
 *
 * 三条语句各自的执行语义（见 apply-schema 路由）：
 *   ① `ALTER TABLE key_usage ADD COLUMN account_id`
 *      · 线上老表：真正补列；随后 `idx_key_usage_account_created` 才能建（否则报 no such column）。
 *      · 全新库：表还没建 → 报 `no such table`（**容忍**，视为成功），随后的 CREATE TABLE 自带该列。
 *      · 已迁移过：报 `duplicate column name`（**容忍**，视为成功）。
 *   ② `ALTER TABLE quotas ADD COLUMN requests`（2026-09-11 技术债 D：真实用户请求数）
 *      · 同样的三种情形由同一套 `isToleratedSchemaError()` 兜住（duplicate column / ALTER 的 no such table）。
 *   ③ `ALTER TABLE ingest_files ADD COLUMN blob_sha`（2026-09-11 技术债 #5：零 chunk 文件的 sha 来源）
 *      · 与 ①② 同一套容忍规则；**只有 blob_sha 非空的行**属于"零 chunk 集合"，Worker 侧摄取不受影响。
 *   ④ `DROP TABLE IF EXISTS bigram_index`（+ 两条 `DROP INDEX IF EXISTS`）
 *      · **天然幂等**：表/索引不存在时 SQLite 不报错，所以不需要容忍规则；
 *        显式删索引是为了"表被人为重建过、索引还在"这种中间态也干净。
 *      · 顺序安全：本数组**先于** SCHEMA_STATEMENTS 执行，而后者已不再创建 bigram_index，
 *        所以新库上 DROP 是空操作，老库上才会真正释放空间（历史 ~52 万行）。
 */
export const SCHEMA_MIGRATIONS: readonly string[] = [
  `ALTER TABLE key_usage ADD COLUMN account_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE quotas ADD COLUMN requests INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ingest_files ADD COLUMN blob_sha TEXT`,
  `DROP TABLE IF EXISTS bigram_index`,
  `DROP INDEX IF EXISTS idx_bigram_gram_wiki`,
  `DROP INDEX IF EXISTS idx_bigram_path_wiki`,
]

/**
 * 判断某条 DDL 的报错是否属于「其实已经是对的状态」而可视为成功（不阻断整批 schema 应用）。
 *
 * ① `duplicate column name` —— 目标列已存在（新库建表时已带上该列，或本迁移已跑过）。
 * ② `no such table` **且语句是 ALTER TABLE** —— 目标表还不存在（全新库先跑迁移的必然结果）；
 *    同一批里随后的 `CREATE TABLE IF NOT EXISTS` 会带上新列，故视为成功。
 *    注意：只对 ALTER 容忍；`CREATE ...` 报 no such table 是**真错误**（例如索引指向不存在的表）。
 * ③ 不需要为 `DROP ... IF EXISTS` 开特例：**它本身就幂等**（目标不存在不报错），
 *    真有报错（库不可用 / 表被锁）必须算 failed，不能被这里吞掉。
 * 其余错误（语法错、约束冲突、库不可用等）一律不宽容，仍进 failed。
 */
export function isToleratedSchemaError(statement: string, message: string | undefined | null): boolean {
  const msg = (message ?? "").toLowerCase()
  if (msg.includes("duplicate column name")) return true
  if (/^\s*alter\s+table\b/i.test(statement ?? "") && msg.includes("no such table")) return true
  return false
}
