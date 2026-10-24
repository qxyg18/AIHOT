// ym770: the statistics release parser reads the monthly retail totals and the limited-size
// clothing/knitwear line from the NBS release page. These cases pin the shapes the automatic chain
// depends on: the ordinary month page, the merged January–February page, the index-page scan, and
// the two refusals (a page without the YTD sentence, a page without the current-month sentence).
// Pure parser only — no network, no database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseRetailRelease, periodFor, pickLatestRelease } from "@aihot/backend/macro/nbs-parse";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

test("ym770: September release carries month and year-to-date retail plus the apparel line", () => {
  const release = parseRetailRelease(fixture("nbs-retail-202609.html"), "https://example.test/202609.html");
  assert.deepEqual(
    { year: release.year, month: release.month, seq: release.seq, label: release.label },
    { year: 2026, month: 9, seq: 9, label: "9月" },
  );
  assert.deepEqual(release.retail, { value: 42433, yoy: 1.1 });
  assert.deepEqual(release.retailYtd, { value: 370001, yoy: 1.1 });
  assert.deepEqual(release.apparel, { value: 1213, yoy: 1.2 });
  assert.deepEqual(release.apparelYtd, { value: 10824, yoy: 4.6 });
  assert.equal(release.publishedAt, "2026-10-19");
});

test("ym770: the merged January–February page yields one seq=1 row labelled 1–2月", () => {
  const release = parseRetailRelease(fixture("nbs-retail-202602.html"), "https://example.test/202602.html");
  assert.equal(release.month, 2);
  assert.equal(release.seq, 1);
  assert.equal(release.label, "1–2月");
  assert.deepEqual(release.retail, { value: 86079, yoy: 2.8 });
  assert.deepEqual(release.apparel, { value: 2831, yoy: 10.4 });
});

test("ym770: only the clothing row is taken from the table, not the neighbouring categories", () => {
  const release = parseRetailRelease(fixture("nbs-retail-202609.html"), "https://example.test/202609.html");
  assert.notDeepEqual(release.apparel, { value: 2224, yoy: 6.7 }); // 粮油、食品类 must never be read as apparel
  assert.deepEqual(release.apparelYtd, { value: 10824, yoy: 4.6 });
});

test("ym770: the index scan picks the newest release and resolves its relative href", () => {
  const link = pickLatestRelease(fixture("nbs-release-index.html"), "https://www.stats.gov.cn/sj/zxfb/");
  assert.ok(link);
  assert.equal(link.year, 2026);
  assert.equal(link.month, 9);
  assert.equal(link.url, "https://www.stats.gov.cn/sj/zxfb/202610/t20261019_1965614.html");
});

test("ym770: a page without the year-to-date sentence is refused, never half-parsed", () => {
  assert.throws(
    () => parseRetailRelease("<html><body><p>没有发布句子的页面</p></body></html>", "https://example.test/x"),
    /year-to-date retail sentence/,
  );
});

test("ym770: an ordinary month page without its current-month sentence is refused", () => {
  const html = "<html><head><title>2026年1—9月份社会消费品零售总额增长1.1%</title></head>"
    + "<body><p>1—9月份，社会消费品零售总额370001亿元，同比增长1.1%。</p></body></html>";
  assert.throws(() => parseRetailRelease(html, "https://example.test/x"), /current-month retail sentence/);
});

test("ym770: a page without the apparel row parses retail and leaves apparel null (the job flags it)", () => {
  const html = "<html><head><title>2026年1—9月份社会消费品零售总额增长1.1%</title></head><body>"
    + "<p>1—9月份，社会消费品零售总额370001亿元，同比增长1.1%。</p>"
    + "<p>9月份，社会消费品零售总额42433亿元，同比增长1.1%。</p>"
    + "<table><tr><td>粮油、食品类</td><td>2224</td><td>6.7</td><td>17738</td><td>6.8</td></tr></table>"
    + "</body></html>";
  const release = parseRetailRelease(html, "https://example.test/x");
  assert.deepEqual(release.retail, { value: 42433, yoy: 1.1 });
  assert.equal(release.apparel, null);
  assert.equal(release.apparelYtd, null);
});

test("ym770: period mapping keeps the seed convention", () => {
  assert.deepEqual(periodFor(9), { seq: 9, label: "9月" });
  assert.deepEqual(periodFor(2), { seq: 1, label: "1–2月" });
});
