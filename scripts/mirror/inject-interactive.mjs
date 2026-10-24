// inject-interactive.mjs — 把客户端交互层接入保真版（幂等）
// 动作：①/all/index.html 注入 <script src="/assets/mirror.js" defer> ②校验 /assets/mirror.js 与 /data/pool.json 在位
// 用法: node inject-interactive.mjs [siteRoot]   默认 D:/myhot-dev/mirror-fidelity
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || "D:/myhot-dev/mirror-fidelity";
const allPage = join(root, "all", "index.html");
const TAG = '<script src="/assets/mirror.js" defer></script>';

for (const f of [allPage, join(root, "assets", "mirror.js"), join(root, "data", "pool.json")]) {
  if (!existsSync(f)) {
    console.error(`MISSING: ${f}`);
    process.exit(1);
  }
}

let html = readFileSync(allPage, "utf8");
if (html.includes("/assets/mirror.js")) {
  console.log("already injected, skip");
} else {
  if (!html.includes("</body>")) {
    console.error("no </body> anchor in all/index.html");
    process.exit(1);
  }
  html = html.replace("</body>", `${TAG}</body>`);
  writeFileSync(allPage, html, "utf8");
  console.log("injected mirror.js into all/index.html");
}
