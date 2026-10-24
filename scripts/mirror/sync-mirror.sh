#!/usr/bin/env bash
# 童装雷达镜像站 · 6h 同步链（导出 → 种子数据 → 全站 BFS 抓取）
# ym307（2026-10-05 命主令）：除搜索外全静态对齐，mirror.js 客户端交互层已下线，无注入步骤。
# 发布与上线验证由调用方（自动化会话）执行；本脚本只做内容构建。
# 退出码：0=构建完成(SYNC_OK)；42=本地真站不可达本轮跳过（非失败）；其它=构建失败
set -uo pipefail
D="/d/myhot-dev"
NODE="C:/Program Files/nodejs/node.exe"
SITE="http://localhost:3000"

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$SITE/")
if [ "$code" != "200" ]; then
  echo "SKIP: 本地真站不可达 (HTTP $code)，本轮同步跳过（docker 栈未运行属正常态）"
  exit 42
fi

echo "[1/3] Postgres → mirror/data 快照"
bash "$D/scripts/mirror/export-mirror.sh" || { echo "FAIL: export-mirror"; exit 1; }
"$NODE" "$D/scripts/mirror/build-db.mjs" || { echo "FAIL: build-db"; exit 1; }

echo "[2/3] pool 种子数据（爬虫种子+熔断比对，不进发布目录）"
"$NODE" "$D/scripts/mirror/export-pool.mjs" || { echo "FAIL: export-pool"; exit 1; }

echo "[3/3] 全站 BFS 抓取（除搜索外全静态对齐）"
"$NODE" "$D/scripts/mirror/crawl-full.mjs" || { echo "FAIL: crawl-full"; exit 1; }

echo "SYNC_OK"
