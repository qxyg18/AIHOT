# 云端发版手册（Shanghai · /srv/radar）

> 首演：2026-10-21（ym767）。正本随仓库走；每次发版按本手册执行，发布事实落 RELEASE.json。
> 本地开发不适用（本地直接 `docker compose up -d --build`）。

## 原则

1. **镜像锚定 commit**：一次发版的全部镜像构建自同一 `git archive HEAD` 快照，tag=commit 短 sha（8 位）。禁止从工作树直接 rsync——未跟踪文件漂移正是 2026-10-17 迁云镜像缺高德线特性的根因。
2. **四容器同生共死**：`up -d` 一次换 api/worker/web/setup（db/cloudflared 镜像 digest 锁定不随发版变）。只换一半=版本错配（ym739 教训：web 被遗漏跑旧镜像四天）。
   **回写义务**：在服务器 release/build 目录里做的任何运维值改动（compose 键、镜像 digest、env、限额）必须回写 git 并提交，否则下次发版按 `git archive HEAD` 重建会被静默抹掉。实例：ym730/C1-10 的 `oom_score_adj: -500` 只落在服务器 overlay 未回写，2026-10-21 22:00 发版即丢失（ym780 回补）；ym752 的占位 digest 同型。判据：发版后逐项比对现役容器实值与 git HEAD 中 compose 的声明，不一致即视为本次发版缺陷。
3. **两道前置闸**（缺一发版中止）：
   - 本地 `npm run typecheck && npm run test`：全绿，或红项**全部落在已登记基线红清单内**（见下节；清单外新红=发版中止）。结果与对照结论贴 RELEASE.json gates。
   - 云端迁移账本核验：待发版新增的 `database/migrations/*.sql` 若云端库已手工建过表，`schema_migrations` 必须已有对应行，否则 setup 跑迁移会撞「表已存在」把四个容器全部拖死（非幂等迁移=停机开关）。核验：`sudo docker exec aihot-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 10"'`，与本次新增迁移清单比对；缺行且表已存在→先补 `INSERT INTO schema_migrations (name) VALUES ('<文件名>')` 再发版。

### 基线红清单（2026-10-21 ym767 首演登记；清单外新红=发版中止）

既有红与已知 flake，非发版面回归，发版闸按「全绿或全部落在清单内」判定：

- admission 族（先于 2026-10-21 发版面存在，1299463 复测实证）：admission-activation-round R1/R4、admission-jobs 发现轮/探测轮、source-admission R2/R5/R7-R11+R13/robots 单元（'unknown'≠'pass' 断言族）。
- 负载/顺序型 flake：analyze-shutdown SIGTERM×3、translate-shutdown SIGTERM×2、translate 用例族、capability-routing insights-selection T7/T8、embeddings（文件级，单独复跑绿）。
- 维护纪律：清单增删须有独立归因证据（如父提交复测），随发版在 RELEASE.json gates 同步当前清单状态。

## 步骤

设 `SHA8=<commit短sha>`、`REL=/srv/radar/releases/<yyyymmdd->-$SHA8>`。

1. 本地：`npm run typecheck && npm run test` → 全绿后提交并 push（或至少 commit）。
2. `git archive HEAD -o /tmp/aihot-$SHA8.tar && gzip /tmp/aihot-$SHA8.tar` → `scp` 到服务器 `/srv/radar/build-$SHA8.tar.gz`。
3. 服务器：`mkdir -p /srv/radar/build-$SHA8 && tar xzf build-$SHA8.tar.gz -C build-$SHA8`。
4. 构建（内存紧，串行；大陆网络走镜像源。**必须 http:// 协议**：该机代理/解析器对 TLS 做中间人，容器内 https 镜像源一律证书校验失败；http 腾讯源实测 1s 拉完 10.2MB）：
   `cd /srv/radar/build-$SHA8 && COMPOSE_PARALLEL_LIMIT=1 sudo -E docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file /srv/radar/releases/<现役>/.env build --build-arg AIHOT_RELEASE=$SHA8 --build-arg APT_MIRROR=http://mirrors.cloud.tencent.com --build-arg NPM_REGISTRY=http://registry.npmmirror.com`（deb.debian.org 从上海机器不可达，不传 APT_MIRROR 会在 apt 层卡死；2026-10-21 实测。`AIHOT_RELEASE` 必须现取 `git rev-parse --short HEAD`，禁手写——它是 /api/health 的唯一来源）。
5. 打 tag：api/worker/web/setup 四镜像 `docker tag aihot-app-<svc>:latest aihot-app-<svc>:$SHA8`。
6. 新 release 目录：`mkdir -p $REL && cp build-$SHA8/docker-compose.yml $REL/ && cp -r build-$SHA8/deploy $REL/ && cp <现役>/.env $REL/`。**复制后必须删除 `.env` 里的 `AIHOT_RELEASE` 行**——版本由镜像 ENV 提供；不删则 env_file 覆盖镜像值，锚继续撒谎（2026-10-22 实测：health 自报 c50bc65，实际镜像 9d7d932c）。
7. changelog 宿主文件（首次才建）：`mkdir -p /srv/radar/shared && cp build-$SHA8/industry/changelog.json /srv/radar/shared/changelog.json`；此后每次发版向该文件头部 inserts 一条 `{date,time,kind:"更新",title,body[]}` 并更新 `latestVersion=<该条目的日期与时间，形如 2026-10-21T22:00>`（api 按文件 mtime 热加载，无需重启）。**latestVersion 是页面展示的版本时点，不是 commit 锚**；commit 锚记在本 release 的 RELEASE.json `commit`/`commit_full`（2026-10-21 首演实发即为时戳口径，本条按实态校正）。
8. 落 RELEASE.json（见下）。
9. 切换：`cd $REL && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file .env up -d`。
10. 验证（见下）→ 通过后把旧 build 目录与旧 release 目录保留（回滚锚），两个版本以外的更旧目录可清。

## RELEASE.json（每个 release 目录一份）

```json
{
  "commit": "$SHA8", "commit_full": "<full sha>", "built_at": "...", "released_at": "...",
  "images": {"api": "aihot-app-api:$SHA8", "worker": "...", "web": "...", "setup": "..."},
  "gates": {"typecheck_test": "<结果摘要+基线红对照结论>", "migration_ledger": "<核验结论>"},
  "changelog_entry": "<本次向 /srv/radar/shared/changelog.json 追加的条目 title>",
  "rollback": "cd <旧release目录> && docker compose ... up -d（或 docker tag 指回旧 tag 后 up -d）"
}
```

## 验证清单（切换后逐项）

- `sudo docker ps`：api/worker/web 同 tag、healthy；setup exited 0。
- **版本三值一致**：`curl -s http://127.0.0.1:3000/api/health` 的 `release` = 本次 `$SHA8` = 运行容器镜像 tag。任一不符即本次发版失败（锚不可信，后续对账全部失效）。
- `sudo docker inspect aihot-db-1 --format '{{.HostConfig.OomScoreAdj}}'` = `-500`，且 `/proc/$(sudo docker inspect -f '{{.State.Pid}}' aihot-db-1)/oom_score_adj` 回读 `-500`（两处都要核：前者是声明值，后者是生效值）。注意 `docker update` 在 Docker 29.x **不支持** `--oom-score-adj`，该值只在容器创建时由 compose 设定，所以这一项只能靠「git 快照带对」+「发版后核」，不能事后补。
- `curl -s http://127.0.0.1:3000/ | grep <title>`（首页 SSR）。
- 本排行榜页抽查（对照本次发版的功能面）。
- `curl -s http://172.18.0.3:3001/api/site/changelog`（经 api 容器 IP）反映第 7 步新条目=热加载生效。
- 24h 内看 job_runs：`ops.alerts` ok、无新增 failed 家族。

## 回滚

`cd <旧 release> && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file .env up -d`。镜像层回滚锚：旧 tag 常驻服务器（docker images 清理时至少保留上一代）。changelog 回滚不必做（条目面向事实，失败发版可补「下线」条目说明）。

## 停机窗口口径

api/worker `stop_grace_period=200s`（在途任务排空），四容器串行替换，web 重建期间 cloudflared 对外短暂 5xx，实测量级=分钟。带破坏性迁移的发版必须先走 expand/contract（先加列后删列），本手册不覆盖该场景时另立卡。
