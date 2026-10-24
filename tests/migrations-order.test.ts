// T01/ym239 契约迁移顺序与旧数据兼容（AC1）：空隔离库的顺序迁移由 scripts/migrate.ts 保证
// （按名序、逐文件事务、schema_migrations 台账）；本测试在 *_test/*_ci 库上断言：
// ①全部迁移文件按名序在册（未迁移=红，先迁移=绿——本卡 VERIFY 的红→绿证据）；
// ②0052 契约迁移在册；③既有列集 INSERT（旧代码写入形状）不被新列破坏，新列读取回落默认。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";

const T = tag();

after(async () => {
  await closeDb();
});

test("迁移名册：database/migrations/*.sql 全量按名序入册，0052 契约迁移在册", async () => {
  const dir = path.join(REPO_ROOT, "database/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("0052_disabled_state_contracts.sql"), "0052 契约迁移文件须存在");
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  assert.deepEqual(rows.map((r) => r.name), files, "已应用迁移须与目录全量一致（含名序）");
});

test("旧数据兼容：既有列集 INSERT 照常成功，本卡新列读取回落默认", async () => {
  const sid = `t01-src-${T}`;
  const aid = `t01-art-${T}`;
  await sql`INSERT INTO sources (id, name, kind) VALUES (${sid}, ${"T01 兼容源 " + T}, 'rss')`;
  // 既有代码的 articles INSERT 列形状（不含本卡新增列）
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${aid}, ${sid}, ${"t01-key-" + T}, ${"https://example.invalid/t01/" + T}, ${"兼容标题"}, now(), now())`;
  const [a] = await sql`SELECT metadata_attempts, metadata_retry_at, metadata_checked_at, published_at_precision, date_conflict
                        FROM articles WHERE id = ${aid}`;
  assert.equal(a.metadata_attempts, 0);
  assert.equal(a.metadata_retry_at, null);
  assert.equal(a.published_at_precision, null);
  assert.deepEqual(a.date_conflict, {});

  const mid = `t01-model-${T}`;
  await sql`INSERT INTO model_watch_models (model_id, name) VALUES (${mid}, ${"T01 兼容模型"})`;
  const [m] = await sql`SELECT policy_version, catalog_version, probe_version, cert_version, provider_facts, version
                        FROM model_watch_models WHERE model_id = ${mid}`;
  assert.equal(m.policy_version, "");
  assert.equal(m.cert_version, "");
  assert.equal(m.version, 1);
  assert.deepEqual(m.provider_facts, {});

  const lk = `t01-receipt-${T}`;
  await sql`INSERT INTO receipts (logical_key, service, purpose, status)
            VALUES (${lk}, ${"t01-service"}, ${"t01-purpose"}, 'pending')`;
  const [r] = await sql`SELECT operation_key, reserved_input_tokens, cost_evidence FROM receipts WHERE logical_key = ${lk}`;
  assert.equal(r.operation_key, null);
  assert.equal(r.reserved_input_tokens, null);
  assert.deepEqual(r.cost_evidence, {});

  // 既有列集 deep read 行（不含 input 身份列）→ 新列回落 NULL（非当前，fail-closed 由查询侧兜底）
  await sql`INSERT INTO article_deep_reads (article_id, status, kind, interpretation)
            VALUES (${aid}, 'ready', 'plain', ${"兼容解读"})`;
  const [d] = await sql`SELECT input_revision, input_hash, attempts, retry_at FROM article_deep_reads WHERE article_id = ${aid}`;
  assert.equal(d.input_revision, null);
  assert.equal(d.input_hash, null);
  assert.equal(d.attempts, 0);

  await sql`DELETE FROM receipts WHERE logical_key = ${lk}`;
  await sql`DELETE FROM model_watch_models WHERE model_id = ${mid}`;
  await sql`DELETE FROM articles WHERE id = ${aid}`;
  await sql`DELETE FROM sources WHERE id = ${sid}`;
});