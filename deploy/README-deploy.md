# 云端发版手册（Shanghai · /srv/radar）

> 首演：2026-10-21（ym767）。正本随仓库走；每次发版按本手册执行，发布事实落 RELEASE.json。
> 本地开发不适用（本地直接 `docker compose up -d --build`）。

## 原则

1. **镜像锚定 commit**：一次发版的全部镜像构建自同一 `git archive HEAD` 快照，tag=commit 短 sha（8 位）。禁止从工作树直接 rsync——未跟踪文件漂移正是 2026-10-17 迁云镜像缺高德线特性的根因。
2. **四容器同生共死**：`up -d` 一次换 api/worker/web/setup（db/cloudflared 镜像 digest 锁定不随发版变）。只换一半=版本错配（ym739 教训：web 被遗漏跑旧镜像四天）。
3. **两道前置闸**（缺一发版中止）：
   - 本地 `npm run typecheck && npm run test` 全绿（提交前跑，结果贴 RELEASE.json）。
   - 云端迁移账本核验：待发版新增的 `database/migrations/*.sql` 若云端库已手工建过表，`schema_migrations` 必须已有对应行，否则 setup 跑迁移会撞「表已存在」把四个容器全部拖死（非幂等迁移=停机开关）。核验：`sudo docker exec aihot-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 10"'`，与本次新增迁移清单比对；缺行且表已存在→先补 `INSERT INTO schema_migrations (name) VALUES ('<文件名>')` 再发版。

## 步骤

设 `SHA8=<commit短sha>`、`REL=/srv/radar/releases/<yyyymmdd->-$SHA8>`。

1. 本地：`npm run typecheck && npm run test` → 全绿后提交并 push（或至少 commit）。
2. `git archive HEAD -o /tmp/aihot-$SHA8.tar && gzip /tmp/aihot-$SHA8.tar` → `scp` 到服务器 `/srv/radar/build-$SHA8.tar.gz`。
3. 服务器：`mkdir -p /srv/radar/build-$SHA8 && tar xzf build-$SHA8.tar.gz -C build-$SHA8`。
4. 构建（内存紧，串行；大陆网络慢走腾讯源）：
   `cd /srv/radar/build-$SHA8 && COMPOSE_PARALLEL_LIMIT=1 sudo -E docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file /srv/radar/releases/<现役>/.env build`（需要时加 `--build-arg NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/`）。
5. 打 tag：api/worker/web/setup 四镜像 `docker tag aihot-app-<svc>:latest aihot-app-<svc>:$SHA8`。
6. 新 release 目录：`mkdir -p $REL && cp build-$SHA8/docker-compose.yml $REL/ && cp -r build-$SHA8/deploy $REL/ && cp <现役>/.env $REL/`。
7. changelog 宿主文件（首次才建）：`mkdir -p /srv/radar/shared && cp build-$SHA8/industry/changelog.json /srv/radar/shared/changelog.json`；此后每次发版向该文件头部 inserts 一条 `{date,time,kind:"更新",title,body[]}` 并更新 `latestVersion=$SHA8`（api 按文件 mtime 热加载，无需重启）。
8. 落 RELEASE.json（见下）。
9. 切换：`cd $REL && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file .env up -d`。
10. 验证（见下）→ 通过后把旧 build 目录与旧 release 目录保留（回滚锚），两个版本以外的更旧目录可清。

## RELEASE.json（每个 release 目录一份）

```json
{
  "commit": "<full sha>", "commit_short": "$SHA8", "built_at": "...", "released_at": "...",
  "images": {"api": "aihot-app-api:$SHA8", "worker": "...", "web": "...", "setup": "..."},
  "gates": {"typecheck_test": "<结果摘要>", "migration_ledger": "<核验结论>"},
  "changelog_entry": "<本次向 /srv/radar/shared/changelog.json 追加的条目 title>",
  "rollback": "cd <旧release目录> && docker compose ... up -d（或 docker tag 指回旧 tag 后 up -d）"
}
```

## 验证清单（切换后逐项）

- `sudo docker ps`：api/worker/web 同 tag、healthy；setup exited 0。
- `curl -s http://127.0.0.1:3000/ | grep <title>`（首页 SSR）。
- 本排行榜页抽查（对照本次发版的功能面）。
- `curl -s http://172.18.0.3:3001/api/site/changelog`（经 api 容器 IP）反映第 7 步新条目=热加载生效。
- 24h 内看 job_runs：`ops.alerts` ok、无新增 failed 家族。

## 回滚

`cd <旧 release> && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file .env up -d`。镜像层回滚锚：旧 tag 常驻服务器（docker images 清理时至少保留上一代）。changelog 回滚不必做（条目面向事实，失败发版可补「下线」条目说明）。

## 停机窗口口径

api/worker `stop_grace_period=200s`（在途任务排空），四容器串行替换，web 重建期间 cloudflared 对外短暂 5xx，实测量级=分钟。带破坏性迁移的发版必须先走 expand/contract（先加列后删列），本手册不覆盖该场景时另立卡。
