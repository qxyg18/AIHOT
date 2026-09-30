// 从 industry/brand/logo.svg 生成各尺寸站点图标（icon.png / icon-192.png / apple-icon.png / favicon.ico）。
// 用法：node scripts/generate-brand-icons.ts
// 依赖 sharp（apps/api 与 packages/backend 已有）。改完 logo.svg 后重跑一次即可。
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const svg = readFileSync("industry/brand/logo.svg");

const targets = [
  { file: "industry/brand/icon.png", size: 512 },
  { file: "industry/brand/icon-192.png", size: 192 },
  { file: "industry/brand/apple-icon.png", size: 180 },
];

for (const t of targets) {
  const buf = await sharp(svg, { density: 384 }).resize(t.size, t.size).png().toBuffer();
  writeFileSync(t.file, buf);
  console.log(`${t.file}  ${t.size}x${t.size}  ${buf.length} bytes`);
}

// favicon.ico：单张 64×64 PNG 内嵌的 ICO（现代浏览器都支持）。
const fav = await sharp(svg, { density: 384 }).resize(64, 64).png().toBuffer();
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(64, 0);
entry.writeUInt8(64, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(fav.length, 8);
entry.writeUInt32LE(22, 12);
writeFileSync("industry/brand/favicon.ico", Buffer.concat([header, entry, fav]));
console.log(`industry/brand/favicon.ico  64x64  ${fav.length + 22} bytes`);
