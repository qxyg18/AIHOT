// 生成镜像站抓取清单：核心静态页 + 全部主题页 + 最新文章详情页
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const MIRROR = "D:/myhot-dev/mirror/data";
const OUT = "D:/myhot-dev/mirror-fidelity";
const ARTICLE_LIMIT = Number(process.env.ARTICLE_LIMIT || 120);

const topics = JSON.parse(readFileSync(path.join(MIRROR, "topics.json"), "utf8"));
const articles = JSON.parse(readFileSync(path.join(MIRROR, "articles.json"), "utf8"));

const core = [
  "/",
  "/all",
  "/hot",
  "/leaderboard",
  "/leaderboard/sources",
  "/leaderboard/rules",
  "/topics",
  "/daily",
  "/weekly",
  "/monthly",
  "/about",
];

const pages = [
  ...core,
  ...topics.map((t) => `/topics/${t.slug}`),
  ...articles.slice(0, ARTICLE_LIMIT).map((a) => `/items/${a.id}`),
];

const WORK = process.env.WORK_DIR || "D:/myhot-dev/scripts/mirror/_work";
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
const file = path.join(WORK, "_pages.json");
writeFileSync(file, JSON.stringify({ pages }, null, 2));
console.log(`清单已生成：${pages.length} 页（核心 ${core.length} + 主题 ${topics.length} + 文章 ${Math.min(ARTICLE_LIMIT, articles.length)}）→ ${file}`);
