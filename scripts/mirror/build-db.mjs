// 童装雷达镜像站 · 快照数据组装（C 方案验证版）
// 读 data/*.json → 生成 data/mirror.db（SQLite），供只读服务消费。
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const OUT = path.join("D:/myhot-dev", "mirror", "data");
const read = (n) => JSON.parse(readFileSync(path.join(OUT, n), "utf8"));

console.log("[1/2] 读取快照 JSON ...");
const articles = read("articles.json");
const boards = read("boards.json");
const topics = read("topics.json");
const hot = read("hot.json");
const meta = read("meta.json");
console.log(`      articles=${articles.length} boards=${boards.length} topics=${topics.length} hot=${hot.length}`);

console.log("[2/2] 组装 SQLite 镜像库 ...");
const dbPath = path.join(OUT, "mirror.db");
rmSync(dbPath, { force: true });
const db = new DatabaseSync(dbPath);
db.exec(`
create table articles (id text primary key, title text, source_name text, published_at text, url text, lead_text text);
create table boards (board text, model_name text, rank integer, score real, confidence text, summary text);
create table topics (slug text primary key, name text, grp text, definition text);
create table hot (idx integer primary key, payload text);
create table meta (key text primary key, value text);
create index articles_time_idx on articles(published_at desc);
create index boards_board_idx on boards(board, rank);
`);

const insArticle = db.prepare("insert into articles values (?,?,?,?,?,?)");
for (const a of articles) insArticle.run(a.id, a.title, a.source_name, a.published_at, a.url, a.lead_text || "");

const insBoard = db.prepare("insert into boards values (?,?,?,?,?,?)");
for (const b of boards) insBoard.run(b.board, b.model_name, b.rank, b.score, b.confidence, b.summary || "");

const insTopic = db.prepare("insert into topics values (?,?,?,?)");
for (const t of topics) insTopic.run(t.slug, t.name, t.grp, t.definition || "");

const insHot = db.prepare("insert into hot values (?,?)");
hot.forEach((h, i) => insHot.run(i, JSON.stringify(h)));

const insMeta = db.prepare("insert into meta values (?,?)");
for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v));

const counts = {
  articles: db.prepare("select count(*) c from articles").get().c,
  boards: db.prepare("select count(*) c from boards").get().c,
  topics: db.prepare("select count(*) c from topics").get().c,
  hot: db.prepare("select count(*) c from hot").get().c,
};
db.close();
console.log(`      SQLite 校验：${JSON.stringify(counts)}，体积 ${(statSync(dbPath).size / 1024).toFixed(1)}KB`);
console.log(`      数据截止：${meta.data_cutoff}（导出时点 ${meta.generated_at}）`);
