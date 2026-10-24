// verify-mirror.cjs — 镜像站 /all 交互层一次性端到端验证（Edge 通道）
const path = require("path");
const { chromium } = require(path.join(
  "C:/Users/yy/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core"
));

const BASE = process.argv[2] || "http://localhost:8096";
const out = {};
const fail = (k, v) => { out[k] = { FAIL: v }; };

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();

  // 1. 默认视图
  await page.goto(`${BASE}/all`, { waitUntil: "networkidle" });
  out.default = {
    cards: await page.locator("[data-item-id]").count(),
    pagerLinks: await page.locator('nav[aria-label="分页"] a').count(),
  };
  if (out.default.cards !== 40) fail("default_cards", out.default.cards);

  // 2. 直达带参数 URL：page=2
  await page.goto(`${BASE}/all?page=2`, { waitUntil: "networkidle" });
  const firstIdP2 = await page.locator("[data-item-id]").first().getAttribute("data-item-id");
  const cur2 = await page.locator('nav[aria-label="分页"] a[aria-current="page"]').textContent();
  out.directPage2 = { firstId: firstIdP2, currentPage: cur2.trim() };
  if (cur2.trim() !== "2") fail("direct_page2", cur2);

  // 3. 翻页点击：回第 1 页对比首条 id 不同
  await page.goto(`${BASE}/all`, { waitUntil: "networkidle" });
  const firstIdP1 = await page.locator("[data-item-id]").first().getAttribute("data-item-id");
  await page.locator('nav[aria-label="分页"] a', { hasText: "下一页" }).click();
  await page.waitForTimeout(300);
  const firstIdAfterClick = await page.locator("[data-item-id]").first().getAttribute("data-item-id");
  out.clickPager = {
    p1First: firstIdP1,
    afterClickFirst: firstIdAfterClick,
    url: page.url(),
    changed: firstIdP1 !== firstIdAfterClick,
  };
  if (firstIdP1 === firstIdAfterClick) fail("click_pager", "内容未变");

  // 4. 筛选：category=statistics（点 chip）
  await page.locator('a[href="/all?category=statistics"]').first().click();
  await page.waitForTimeout(300);
  const cats = await page.locator("[data-item-id] .text-ink-4 a").allTextContents();
  const chipActive = await page.locator('a[href="/all?category=statistics"][aria-current="page"]').count();
  out.filterCategory = {
    url: page.url(),
    cards: await page.locator("[data-item-id]").count(),
    chipActive,
    sampleCats: cats.slice(0, 3),
  };
  if (!page.url().includes("category=statistics")) fail("filter_url", page.url());

  // 5. 搜索：q=棉（表单提交）
  await page.goto(`${BASE}/all`, { waitUntil: "networkidle" });
  await page.fill("#site-search", "棉");
  await page.press("#site-search", "Enter");
  await page.waitForTimeout(400);
  const foundText = await page.locator("#mirror-toolbar").textContent().catch(() => "");
  const searchCards = await page.locator("[data-item-id]").count();
  out.search = { url: page.url(), foundText: foundText.trim(), cards: searchCards };
  if (!page.url().includes("q=")) fail("search_url", page.url());
  if (!/找到/.test(foundText)) fail("search_toolbar", foundText);

  // 6. 搜索+排序 tab：全文相关
  const relTab = page.locator('#mirror-toolbar a', { hasText: "全文相关" });
  if (await relTab.count()) {
    await relTab.click();
    await page.waitForTimeout(300);
    out.relevanceTab = { url: page.url(), cards: await page.locator("[data-item-id]").count() };
  } else fail("relevance_tab", "tab 不存在");

  // 7. 组合：tag 筛选
  await page.goto(`${BASE}/all?tag=${encodeURIComponent("门店")}`, { waitUntil: "networkidle" });
  out.tagFilter = { url: page.url(), cards: await page.locator("[data-item-id]").count() };

  // 8. 无结果
  await page.goto(`${BASE}/all?q=${encodeURIComponent("zzz不存在词zzz")}`, { waitUntil: "networkidle" });
  out.empty = { cards: await page.locator("[data-item-id]").count(), body: (await page.locator("div.transition-opacity").textContent()).slice(0, 40) };

  // 9. 静态页回归：首页与详情页未被交互层影响
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  out.home = { cards: await page.locator("[data-item-id]").count(), toolbar: await page.locator("#mirror-toolbar").count() };

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
