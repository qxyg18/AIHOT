// cleanup-mirror.mjs — 发布验证成功后的缓存清理（命主 2026-10-04 令：成功即清，失败保留供排查）
// 清理面：①抓取中间件 _work/_pages.json、_work/_failed.json（manifest.json 保留供审计追溯）
//         ②过期内容目录：managed roots 下不在本轮 manifest 里的目录（递归取最浅未收录层）
// 三重防线（守门员审计 ym306 M1/P1 修法）：
//   a. manifest 缺失或路由数 <200 → 跳过目录清理（防数据层异常放大为删除事故）
//   b. 单层可反解路由的目录（items/<id> 等），删除前回源 HEAD 探测，仅删真站也 404 的
//   c. 真站不可达 → 跳过全部目录清理（探测通道失效时宁留不删）
// 用法: node cleanup-mirror.mjs [siteRoot]
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.argv[2] || "D:/myhot-dev/mirror-fidelity";
const WORK = "D:/myhot-dev/scripts/mirror/_work";
const ORIGIN = process.env.SRC_BASE || "http://localhost:3000";
const removed = [];
const skipped = [];

// ①中间件
for (const f of ["_pages.json", "_failed.json"]) {
  const p = path.join(WORK, f);
  if (existsSync(p)) {
    rmSync(p);
    removed.push(`_work/${f}`);
  }
}
// 历史遗留（老版本曾落在发布目录）
for (const f of ["_pages.json", "_failed.json"]) {
  const p = path.join(root, f);
  if (existsSync(p)) {
    rmSync(p);
    removed.push(f);
  }
}

// ②manifest 驱动的过期目录清理
const MANAGED_ROOTS = ["items", "story", "stories", "entity", "leaderboard", "topics", "daily", "weekly", "monthly", "all"];
const manifestFile = path.join(WORK, "manifest.json");

const headProbe = async (route) => {
  try {
    const r = await fetch(ORIGIN + route, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return r.status;
  } catch {
    return -1; // 不可达/超时（审计 R2 #3：挂起连接一律按不可达，跳过删除）
  }
};

const run = async () => {
  if (!existsSync(manifestFile)) {
    console.warn("CLEAN_SKIP: manifest.json 缺失，跳过目录清理");
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const { routes } = manifest;
  if (!Array.isArray(routes) || routes.length < 200) {
    console.warn(`CLEAN_SKIP: manifest 路由数 ${routes?.length ?? 0}（<200 下限），疑似异常，跳过目录清理`);
    return;
  }
  // 陈旧 manifest 防御（审计 R2 #4）：抓取时刻超过 24h 的 manifest 不作为删除权威
  const ageH = (Date.now() - Date.parse(manifest.crawledAt || 0)) / 36e5;
  if (!(ageH >= 0 && ageH < 24)) {
    console.warn(`CLEAN_SKIP: manifest 已陈旧（${ageH.toFixed(1)}h），不作为删除依据，跳过目录清理`);
    return;
  }

  // 期望目录集合：每条路由映射后的所有祖先目录
  const keepDirs = new Set();
  for (const route of routes) {
    const [p, q] = route.split("?");
    let dir = p.replace(/^\//, "").replace(/\/$/, "");
    if (q) {
      const slug = q
        .split("&")
        .map((kv) => kv.replace(/=+/g, "-").replace(/[^A-Za-z0-9\-_\u4e00-\u9fa5]/g, ""))
        .join("-");
      dir = dir ? `${dir}/${slug}` : slug;
    }
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) keepDirs.add(parts.slice(0, i).join("/"));
  }

  // 真站可达性预检（防线 c）
  const probe0 = await headProbe("/");
  if (probe0 !== 200) {
    console.warn(`CLEAN_SKIP: 真站不可达（HEAD / → ${probe0}），跳过目录清理（宁留不删）`);
    return;
  }

  // 递归收集「最浅未收录目录」候选
  const candidates = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const child = `${rel}/${d.name}`;
      if (!keepDirs.has(child)) candidates.push(child);
      else walk(child); // 在收录链上才继续下钻（审计 P1：entity 二级死角）
    }
  };
  for (const r of MANAGED_ROOTS) walk(r);

  // 防线 b：可反解为单层路由的目录，回源 HEAD 探测，仅删真站 404 的
  for (const rel of candidates) {
    const segs = rel.split("/");
    // 可反解白名单（审计 R2 #2）：路径形态与路由一一对应的才回源探测；
    // 非对应形态（如 leaderboard/category/overall 目录）路由=目录可直接 HEAD，也放行探测
    const reversible =
      (["items", "story", "stories", "topics", "leaderboard", "daily", "weekly", "monthly"].includes(segs[0]) && segs.length === 2) ||
      (segs[0] === "entity" && segs.length === 3);
    if (reversible) {
      const status = await headProbe("/" + rel);
      if (status === -1) {
        console.warn(`CLEAN_SKIP: 探测中断（${rel}），剩余候选全部保留`);
        break;
      }
      if (status !== 404) {
        skipped.push(`${rel}(真站${status})`);
        continue;
      }
    }
    rmSync(path.join(root, rel), { recursive: true });
    removed.push(rel);
  }
};

await run();
console.log(`CLEAN_OK removed=${removed.length}${removed.length ? " : " + removed.slice(0, 20).join(", ") + (removed.length > 20 ? ` …+${removed.length - 20}` : "") : ""}`);
if (skipped.length) console.log(`CLEAN_KEPT（真站仍可访问，未删）=${skipped.length}${skipped.length ? " : " + skipped.slice(0, 10).join(", ") : ""}`);
