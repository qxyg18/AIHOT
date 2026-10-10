// T01/ym239 契约 DB 约束与三反例（AC2/AC3，G00 缺口补全项）：
// ①endpoint_identity 唯一 / CAS 版本 / 手动 tombstone 一致性；候选 checks 与验收样本 append-only；
// ②operationKey 跨模型可查（unknown 跨模型停车的读面）+ deepread input identity 失效判定；
// ③capability 存储 fail-closed（无默认行、未知能力被拒、撤权留痕）。
// 留在库里被 append-only 守卫保护的测试行属预期（不可删=证据不可篡改的证明）。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";

const T = tag();
const identity = (s: string) => `t01://${s}-${T}`;

after(async () => {
  await closeDb();
});

test("AC2 反例：endpoint_identity 唯一——同 endpoint 并发发现只落一行", async () => {
  const id1 = identity("dup");
  await sql`INSERT INTO source_candidates (endpoint_identity, url) VALUES (${id1}, ${"https://example.invalid/a"})`;
  await assert.rejects(
    sql`INSERT INTO source_candidates (endpoint_identity, url) VALUES (${id1}, ${"https://example.invalid/b"})`,
    /violates unique constraint|duplicate key/i,
  );
});

test("AC2 反例：CAS 版本与手动 tombstone 一致性约束", async () => {
  await assert.rejects(
    sql`INSERT INTO source_candidates (endpoint_identity, url, version)
        VALUES (${identity("v0")}, ${"https://example.invalid/v0"}, 0)`,
    /violates check constraint/i,
  );
  await assert.rejects(
    sql`INSERT INTO source_candidates (endpoint_identity, url, manual_retired)
        VALUES (${identity("ret-bad")}, ${"https://example.invalid/ret-bad"}, true)`,
    /violates check constraint/i,
  );
  await sql`INSERT INTO source_candidates (endpoint_identity, url, manual_retired, retired_at, retired_by)
            VALUES (${identity("ret-ok")}, ${"https://example.invalid/ret-ok"}, true, now(), ${"owner-test"})`;
});

test("AC2 反例：候选 checks append-only——INSERT 允许，UPDATE/DELETE 被拒", async () => {
  await sql`INSERT INTO source_candidates (endpoint_identity, url)
            VALUES (${identity("checks")}, ${"https://example.invalid/checks"})`;
  const [c] = await sql`SELECT id FROM source_candidates WHERE endpoint_identity = ${identity("checks")}`;
  await sql`INSERT INTO source_candidate_checks (candidate_id, check_key, verdict, evidence)
            VALUES (${c.id}, 'robots', 'pass', ${sql.json({ note: "t01-verify" })})`;
  await assert.rejects(
    sql`UPDATE source_candidate_checks SET verdict = 'fail' WHERE candidate_id = ${c.id}`,
    /append-only/,
  );
  await assert.rejects(
    sql`DELETE FROM source_candidate_checks WHERE candidate_id = ${c.id}`,
    /append-only/,
  );
});

test("AC2 反例：模型验收样本 append-only", async () => {
  const mid = `t01-evcap-${T}`;
  await sql`INSERT INTO model_free_eval_samples (model_id, capability, verdict, pass_count)
            VALUES (${mid}, ${"t01-cap"}, 'qualified', 10)`;
  await assert.rejects(
    sql`UPDATE model_free_eval_samples SET pass_count = 11 WHERE model_id = ${mid}`,
    /append-only/,
  );
  await assert.rejects(
    sql`DELETE FROM model_free_eval_samples WHERE model_id = ${mid}`,
    /append-only/,
  );
});

test("AC3 反例：operationKey 跨模型——同键两模型行可共存并按键查询到 unknown", async () => {
  const ok = `t01-op-${T}`;
  await sql`INSERT INTO receipts (logical_key, service, model, purpose, status, operation_key)
            VALUES (${ok + "-a"}, ${"t01-service"}, ${"model-a"}, ${"t01-purpose"}, 'unknown', ${ok})`;
  await sql`INSERT INTO receipts (logical_key, service, model, purpose, status, operation_key)
            VALUES (${ok + "-b"}, ${"t01-service"}, ${"model-b"}, ${"t01-purpose"}, 'pending', ${ok})`;
  const rows = await sql`SELECT model, status FROM receipts WHERE operation_key = ${ok} ORDER BY model`;
  assert.equal(rows.length, 2, "同 operation_key 跨模型两行均可按键查得（键不含 model 的读面）");
  assert.ok(rows.some((r) => r.status === "unknown"), "unknown 行在键查询内可见（跨模型停车判据）");
  await sql`DELETE FROM receipts WHERE operation_key = ${ok}`;
});

test("AC3 反例：deepread input identity——revision 前进或 legacy NULL 均非当前有效", async () => {
  const sid = `t01-ds-${T}`;
  const aid = `t01-da-${T}`;
  const aidLegacy = `t01-dal-${T}`;
  await sql`INSERT INTO sources (id, name, kind) VALUES (${sid}, ${"T01 深读源 " + T}, 'rss')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${aid}, ${sid}, ${"t01-dk-" + T}, ${"https://example.invalid/d/" + T}, ${"深读标题"}, now(), now())`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${aidLegacy}, ${sid}, ${"t01-dkl-" + T}, ${"https://example.invalid/dl/" + T}, ${"legacy 深读"}, now(), now())`;
  const hash = `sha256:${T}`;
  await sql`INSERT INTO article_deep_reads (article_id, status, kind, interpretation, input_revision, input_hash)
            VALUES (${aid}, 'ready', 'plain', ${"解读"}, 1, ${hash})`;
  await sql`INSERT INTO article_deep_reads (article_id, status, kind, interpretation)
            VALUES (${aidLegacy}, 'ready', 'plain', ${"legacy 解读"})`;

  const current = (articleId: string) => sql`SELECT 1 FROM article_deep_reads d
      JOIN articles a ON a.id = d.article_id
      WHERE d.article_id = ${articleId} AND d.status = 'ready'
        AND d.input_revision = a.revision AND d.input_hash = ${hash}`;
  assert.equal((await current(aid)).length, 1, "input 版本与当前一致=有效");
  assert.equal((await current(aidLegacy)).length, 0, "legacy NULL 输入=NULL 非当前（不猜旧输入）");

  await sql`UPDATE articles SET revision = revision + 1 WHERE id = ${aid}`;
  assert.equal((await current(aid)).length, 0, "revision 前进后旧输入立即失效");

  await sql`DELETE FROM articles WHERE id IN (${aid}, ${aidLegacy})`;
  await sql`DELETE FROM sources WHERE id = ${sid}`;
});

test("AC3 反例：capability 存储 fail-closed——无默认授权、未知能力被拒、撤权留痕", async () => {
  const principal = `t01-${T}@local`;
  const [none] = await sql`SELECT count(*)::int AS n FROM admin_cap_grants
                           WHERE principal = ${principal} AND revoked_at IS NULL`;
  assert.equal(none.n, 0, "未授权 principal 无任何能力行（服务端判空=拒绝，不默认升级）");
  await assert.rejects(
    sql`INSERT INTO admin_cap_grants (principal, capability, granted_by)
        VALUES (${principal}, ${"channel:super"}, ${"t01-test"})`,
    /violates check constraint/i,
  );
  await sql`INSERT INTO admin_cap_grants (principal, capability, granted_by)
            VALUES (${principal}, 'channel:read', ${"t01-test"})`;
  await sql`UPDATE admin_cap_grants SET revoked_at = now()
            WHERE principal = ${principal} AND capability = 'channel:read'`;
  const [afterRevoke] = await sql`SELECT count(*)::int AS n FROM admin_cap_grants
                                  WHERE principal = ${principal} AND revoked_at IS NULL`;
  assert.equal(afterRevoke.n, 0, "撤权后不再有效（行保留=审计留痕）");
  await sql`DELETE FROM admin_cap_grants WHERE principal = ${principal}`;
});

test("T19 桥：重复导入幂等键唯一、默认待核、五状态词表受约束", async () => {
  const ah = `sha256-t01-${T}`;
  await sql`INSERT INTO store_archive_bridge (archive_hash, row_ref) VALUES (${ah}, ${"Sheet1!2"})`;
  const [r] = await sql`SELECT open_state FROM store_archive_bridge WHERE archive_hash = ${ah} AND row_ref = ${"Sheet1!2"}`;
  assert.equal(r.open_state, "pending_review", "默认待核——不自动判已确认在营");
  await assert.rejects(
    sql`INSERT INTO store_archive_bridge (archive_hash, row_ref) VALUES (${ah}, ${"Sheet1!2"})`,
    /violates unique constraint|duplicate key/i,
  );
  await assert.rejects(
    sql`INSERT INTO store_archive_bridge (archive_hash, row_ref, open_state)
        VALUES (${ah}, ${"Sheet1!3"}, ${"maybe_open"})`,
    /violates check constraint/i,
  );
  await sql`DELETE FROM store_archive_bridge WHERE archive_hash = ${ah}`;
});