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

#### CI 基线（GitHub Actions，2026-10-22）

首次真正执行（此前 5 次全部 `action_required`/0s）。与生产同 commit 的 run 是 **39753561184**（head `862bba0`，`migrate/linux`）：`docker` job 通过；`check` job 在 Backend tests 失败，红项 **14 条，全部落在上列基线族内，新增红 0**（前一次 run 39750730540 / head `5812174` 的 14 条名单与之完全相同，两次互证不是偶然 flake）：

| 归因组 | 用例 | 失败面 |
|---|---|---|
| 阀门未开（`SOURCE_PROBE_ENABLED off`） | admission-activation-round R1/R4、admission-jobs 发现轮/探测轮 | 断言「流程已跑」，实际阀门关闭、轮次未执行 |
| robots/网络依赖断言族 | source-admission R2/R5/R7/R8/R9/R10/R11+R13/robots 单元 | 期望 `robots-disallowed` 等，实得 `robots-unreachable`/`parked`/`probing`（`127.0.0.1` stub 被 SSRF guard 拦，缺 `ALLOW_PRIVATE_NETWORK_FETCH=true`） |
| 共享测试库残留 | backfill-scripts T7/T8 | 计数 14≠4、13≠3，两处同为常数 +10：同库先序文件写入的 pass analyses 未被清理，而 `backfill-insights.ts` 的选取全局无 source 过滤（非本文件残留，亦非产品回归） |

维护：本表只登记归因，不承诺修复；清单变化同样须独立归因。二次判据仍是「新增红 0」。

逐条 `file:line`、断言原文与归因见 `artifacts/2026-10-22/ym901-k8-build-memory/report.md`（K8/ym901 复核）。根因是**测试运行器未注入测试文件头声明的三个环境变量**（`SOURCE_DISCOVERY_ENABLED`、`SOURCE_PROBE_ENABLED`、`ALLOW_PRIVATE_NETWORK_FETCH`），以及 T7/T8 的**跨文件共享库残留**（先序文件写入的 pass analyses 未被清理，选取全局无 source 过滤），**均非产品回归、也非随机 flake**（12 条 env + 2 条隔离，确定性复现）；修法是给运行器按文件注入 env / 在文件间清池，或把断言限定到本用例新建 article id，而不是改断言期望数字。

### 构建内存实测与限额（2026-10-22 K6/K8 实测；**不要用 CLI 级限额**）

- **实测峰值**：一次 `--no-cache` 四镜像构建，`docker.service` cgroup `memory.peak` 读到 **1.30GB**（该值自 dockerd 启动累计，含历次构建，故为上限）；构建期间宿主机 available 最低观测 **2.10GB**，全程无 OOM 事件，四镜像构建成功。
- **`docker build --memory` 无效**：BuildKit 下既不报错也不生效（no-op 构建日志无 `ignoring` 警告，属静默忽略）。
- **`systemd-run --scope -p MemoryMax=2G` 包 CLI 无效，且有假绿风险**：构建负载在 dockerd 内，scope 内只有客户端。实测 scope 峰值仅 **44.9MB**，同期真实峰值 1.30GB —— 限额看似生效、实则不约束构建。**禁止**以此申报「已加限额」。
- **buildx 容器驱动可真正限额（2026-10-22 K8/ym901 实测已跑通）**：K6 的结论写的是「除非先配好可用的 registry mirror」；K8 补齐这个前提后跑通，不是推翻 K6。`/tmp/k8-buildkitd.toml` 写 `[registry."docker.io"]` 与 `mirrors = ["mirror.ccs.tencentyun.com"]`，再 `sudo docker buildx create --name k8cap2g --driver docker-container --driver-opt image=moby/buildkit:buildx-stable-1 --driver-opt memory=2g --driver-opt memory-swap=2g --buildkitd-config /tmp/k8-buildkitd.toml`；builder 容器 `HostConfig.Memory=2147483648`、cgroup `memory.max=2147483648`（实测），`Restart=unless-stopped`。在该 builder 上跑冷构建（无缓存，含 apt + npm ci + next build）：`memory.peak=1,224,417,280 B`（**1,167.7 MiB = 1.1403 GiB，占 2 GiB 上限 57.0%**），23 个 DONE 行（19 个步骤，#4 多次 DONE）、0 error；1 Hz 采样 235 次（构建窗口约 87 次）四生产容器全程 healthy，宿主最小 available 1,582.2 MiB。compose v5.3.1 的 `build --builder k8cap2g --dry-run` 已实测通过，真实 buildx 暖构建 `exit=0`。
- 因此服务器构建的现行控制是**两层**：步骤 4 的前置内存闸（快速失败）+ 硬隔离构建 `--builder k8cap2g`（限额落在 buildkit 容器 cgroup，超限只杀构建）。K7 仍可把构建迁 CI；迁移完成前，服务器侧并非「无有效 cgroup 隔离」。
- 受控隔离实验（2026-10-22）：128M 限额容器内分配 400MB → `docker events` 记录 `oom` 命中该容器；四个生产容器同期全程 healthy。说明 cgroup 级 OOM 只杀本 cgroup 内进程。**默认 daemon builder 无有效 cgroup 隔离**，该结论不能套用到它；用 `k8cap2g` 时限额在 buildkit 容器 cgroup 上，本次实测峰值仅占上限 57%（未做 OOM 负控，余量结论不外推到更低上限）。

## 步骤

设 `SHA8=<commit短sha>`、`REL=/srv/radar/releases/<yyyymmdd->-$SHA8>`。

1. 本地：`npm run typecheck && npm run test` → 全绿后提交并 push（或至少 commit）。
2. `git archive HEAD -o /tmp/aihot-$SHA8.tar && gzip /tmp/aihot-$SHA8.tar` → `scp` 到服务器 `/srv/radar/build-$SHA8.tar.gz`。
3. 服务器：`mkdir -p /srv/radar/build-$SHA8 && tar xzf build-$SHA8.tar.gz -C build-$SHA8`。
4. 构建（内存紧，串行；大陆网络走镜像源。**必须 http:// 协议**：该机代理/解析器对 TLS 做中间人，容器内 https 镜像源一律证书校验失败；http 腾讯源实测 1s 拉完 10.2MB）：
   `cd /srv/radar/build-$SHA8 && COMPOSE_PARALLEL_LIMIT=1 sudo -E docker compose -f docker-compose.yml -f deploy/docker-compose.cloud.yml --env-file /srv/radar/releases/<现役>/.env build --build-arg AIHOT_RELEASE=$SHA8 --build-arg APT_MIRROR=http://mirrors.cloud.tencent.com --build-arg NPM_REGISTRY=http://registry.npmmirror.com`（deb.debian.org 从上海机器不可达，不传 APT_MIRROR 会在 apt 层卡死；2026-10-21 实测。`AIHOT_RELEASE` 必须现取 `git rev-parse --short HEAD`，禁手写——它是 /api/health 的唯一来源）。**构建前先过内存闸**：`[ "$(free -m | awk '/^Mem:/{print $7}')" -ge 1800 ] || { echo "available<1800MB，禁止在服务器构建（实测峰值 1.14GiB；docker.service 累计口径 1.30GB）"; exit 1; }`。不用 `--memory`，也不要用 `systemd-run` 包 CLI——两者都不约束真正的构建负载，理由见上节「构建内存实测与限额」。**要硬隔离时在 `build` 后加 `--builder k8cap2g`**（builder 未就绪先用上节命令创建；重启后先 `sudo docker buildx inspect --bootstrap k8cap2g`；该路径已用 `--dry-run` 验证参数被接受，正式发版首次使用时按验证清单核对镜像 tag）。
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
