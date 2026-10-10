#!/usr/bin/env bash
# 童装雷达镜像站 · 一键刷新快照（导出 → 组装 SQLite）
# 用法：bash D:/myhot-dev/scripts/mirror/refresh.sh
set -euo pipefail
D="/d/myhot-dev"
NODE="C:/Program Files/nodejs/node.exe"

bash "$D/scripts/mirror/export-mirror.sh"
"$NODE" "$D/scripts/mirror/build-db.mjs"
echo "快照已刷新。重新发布 D:/myhot-dev/mirror 即可更新公网镜像。"
