// 条目反馈端点（ym44）的防伪面：没在这一期刊过的条目（伪造的 itemId）一律 400 且零落行；
// 真条目的标记落 feedback 一行、forward_error 为 NULL——重发清扫只捡 forward_error 非空的行，
// 条目反馈因此永远不进内部群（ym44 的既定口径）。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
process.env.FEISHU_INTERNAL_ENABLED = "false";
const app = await buildApp();

// 找一个本套测试还没占用的日报期号，插一期只含一个条目的最小日报（内容里带唯一 tag 便于自清）。
const ITEM = `it${T}x`;
let key = "";
for (const candidate of ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]) {
  const [taken] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${candidate}`;
  if (!taken) { key = candidate; break; }
}
if (!key) throw new Error("no free daily report key for the fixture");
await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
  VALUES ('daily', ${key}, now() - interval '1 day', now(), ${sql.json({ sections: [{ label: "行业", items: [{ itemId: ITEM, title: "测试条目" }] }], flashes: [], themes: [] })}::jsonb, now(), 'test', 'model')`;

const mark = (itemId: string, useful: boolean, ip: string) =>
  app.inject({ method: "POST", url: "/api/site/report-feedback", headers: { "x-real-ip": ip }, payload: { itemId, useful, kind: "daily", key } });
const rowsWithT = async () =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM feedback WHERE content LIKE ${`%${T}%`}`)[0]!.n;

after(async () => {
  await sql`DELETE FROM feedback WHERE content LIKE ${`%${T}%`}`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${key}`;
  await app.close();
  await closeDb();
});

test("a forged itemId is rejected with 400 and writes nothing", async () => {
  const forged = await mark(`zz${T}f`, true, "203.0.113.221");
  assert.equal(forged.statusCode, 400, forged.body);
  const malformed = await mark("bad id!", true, "203.0.113.222");
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(await rowsWithT(), 0, "两个负例都不许落行");
});

test("a mark on an entry the issue ran is stored quietly with no forward_error", async () => {
  const ok = await mark(ITEM, true, "203.0.113.223");
  assert.equal(ok.statusCode, 204);
  const [row] = await sql<{ content: string; page_url: string; forward_error: string | null; forwarded_at: Date | null }[]>`
    SELECT content, page_url, forward_error, forwarded_at FROM feedback WHERE content LIKE ${`%${T}%`} ORDER BY id DESC LIMIT 1`;
  assert.equal(row!.content, `【条目反馈】有用 item=${ITEM} report=daily:${key}`);
  assert.equal(row!.page_url, `/daily/${key}`);
  assert.equal(row!.forward_error, null, "forward_error 为 NULL：重发清扫不会碰条目反馈，不进内部群");
  assert.equal(row!.forwarded_at, null);
});
