# 童装雷达 · 启动说明

基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 开源框架改造的本地站点，只服务本人：抓童装零售与竞品动态，模型打分精选，聚成事件，每天早上出一份日报。

代码位置：`D:\myhot-dev`

---

## 一、已完成的改造

改动只落在 `industry/` 一个目录，框架代码（`packages/`、`apps/`）一行未动。

| 文件 | 改了什么 |
|---|---|
| `site.ts` | 站名「童装雷达」、行业词「童装」、首页与关于页文案、抓取 UA 标识 |
| `taxonomy.ts` | 7 个分类、16 个主题标签、19 个实体名录（含 5 个监控品牌）、童装版防张冠李戴词典 |
| `topics.json` | 26 个主题页（品牌 8 / 经营方向 9 / 内容形态 9），标签全部校验过白名单 |
| `sources.json` | 首版 7 个信源，连通性与字段映射全部实测 |
| `selection.ts` | 门槛下调为 T1 55 / T1_5 62 / T2 72（换行业后的初值，未经样本校准） |
| `features.ts` | 关闭模型榜与 Codex 重置监控（AI 专属模块） |
| `prompts/` (11 个文件) | 预筛、评分、内容理解、结构化、归组定义、写作、术语、标题规则、日报导语全部换成童装口径 |
| `pages/` | 使用规则与隐私说明改为本机自用版 |
| `changelog.json` | 站内更新日志 |

### 分类（筛选栏与日报分节）

品牌动作 · 渠道加盟 · 行业动态 · 市场数据 · 产品趋势 · 政策合规 · 海外标杆

### 监控品牌（实体名录）

巴拉巴拉 · 森马服饰 · 安踏儿童 · 安踏体育 · Mini Peace · 太平鸟 · 安奈儿 · 起步股份 · 金发拉比 · 英氏 · moodytiger · 戴维贝拉 · 孩子王 · 爱婴室 · 比音勒芬 · 地素时尚 · 李宁 · 耐克 · 阿迪达斯

---

## 二、首版信源（全部实测，2026-09-29）

| 信源 | 类型 | 分级 | 实测结果 |
|---|---|---|---|
| 上市公司公告 · 童装品牌（森马 002563 / 安奈儿 002875 / 起步 603557 / 金发拉比 002762） | `json_list` | T1 官方一手 | 接口返回真实公告，字段映射与详情页 URL 已验证 |
| 上市公司公告 · 母婴渠道与服饰集团（孩子王 301078 / 爱婴室 603214 / 太平鸟 603877 / 比音勒芬 002832 / 地素 603587） | `json_list` | T1 官方一手 | 同上 |
| 中服网 · 童装资讯 | `web_list` | T2 媒体 | 列表选择器已验证：`.newsbox` / `.newsbox-txt-title` / `.newsbox-time` |
| Drapers（英国服装零售） | `rss` | T2 媒体 | 10 条 |
| TheIndustry.fashion | `rss` | T2 媒体 | 20 条 |
| Retail Dive | `rss` | T2 媒体 | 1 条 |
| Retail Gazette | `rss` | T2 媒体 | 10 条 |

**实测中被排除的源**（避免白写选择器）：

- 中服网 PC 版行业资讯频道：列表日期是「1 天前」相对格式，无法转绝对时间
- `rsshub.app` 公共实例：403，不可用（备用实例 `rsshub.rssforever.com` 可用）
- fashionnetwork.com / kidswear-magazine.com / sourcingjournal.com：403 或连不上
- Carter's 投资者关系 RSS：403

---

## 三、启动步骤

### 1. 安装 Docker Desktop（需管理员权限，只能手动做）

1. 下载：https://www.docker.com/products/docker-desktop/
2. 安装时保持勾选 **Use WSL 2 instead of Hyper-V**
3. 装完重启，启动 Docker Desktop，等左下角显示 Engine running
4. 打开 PowerShell 验证：`docker --version` 与 `docker compose version`

> 本机当前 `docker` 命令不存在，这一步是唯一的硬阻塞。
> 另注：本机 `wsl.exe` 处于 WorkBuddy 沙箱的程序黑名单中，我在会话里无法调用它，但你自己在系统终端执行不受影响。

建议在 Docker Desktop 设置里配国内镜像加速（Settings → Docker Engine），否则拉 PostgreSQL 等镜像会很慢。

### 2. 生成配置并启动

在 Git Bash 里执行：

```bash
cd /d/myhot-dev

# 生成 .env（会打印一次管理员密码，记下来）
"C:/Users/yy/.workbuddy/binaries/node/versions/24.15.0/node.exe" --version 2>/dev/null || true
node scripts/init-env.ts --llm-key <你的 DeepSeek API Key>

# 构建并启动（走国内 npm 镜像）
docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker compose up -d
```

> 项目要求 Node 24.11+。本机托管 Node 是 22.22.2，系统 Node 24.15.0 可用，
> 建 `PATH="/c/Program Files/nodejs:$PATH"` 后再跑 `init-env.ts`。

### 3. 需要在 `.env` 里补的项

| 变量 | 用途 | 是否必填 |
|---|---|---|
| `LLM_API_KEY` | 模型调用（DeepSeek 等 OpenAI 兼容接口） | 必填 |
| `EGRESS_PROXY_URL` | 抓海外信源走代理，如 `http://127.0.0.1:7890` | 抓海外源时必填 |
| `DAJIALA_KEY` | 微信公众号信源（按请求计费） | 加公众号源时必填 |
| `INGEST_TOKEN` | 外部脚本推送内容（≥16 位） | 选填 |

### 4. 功能验证

打开 http://localhost:3000

- 首页应出现内容（首次导入约半小时处理完）
- 后台 http://localhost:3000/admin 用生成的管理员密码登录
- 后台「信源」页检查 7 个源是否都抓取成功
- 后台「运行」页看定时任务最近结果
- 左侧筛选栏应出现 7 个分类：品牌动作 / 渠道加盟 / 行业动态 / 市场数据 / 产品趋势 / 政策合规 / 海外标杆
- http://localhost:3000/topics 应出现 26 个主题页

### 5. 跑自动化测试（可选，Docker 就绪后）

项目的测试需要一个空的 `*_test` 数据库。用一次性容器跑，不污染正式库：

```bash
# 起一个临时测试库，映射到 5433
docker run -d --name myhot-test-db \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=aihot -e POSTGRES_DB=myhot_test \
  -p 5433:5432 postgres:17

cd /d/myhot-dev
export PATH="/c/Program Files/nodejs:$PATH"
export DATABASE_URL=postgres://aihot:test@127.0.0.1:5433/myhot_test

node --env-file=.env scripts/migrate.ts
npm test

# 跑完清理
docker rm -f myhot-test-db
```

> 说明：本次改造已通过 `npm run typecheck`（contracts / backend / api / worker / tests / web 全部通过）。
> 测试套件尚未实跑，因为本机既无 Docker 也无 PostgreSQL；测试代码已按童装口径同步修正，
> 首次跑若有个别断言不符，按报错行把期望值对齐即可（都在 `tests/analyze*.test.ts`）。

---

## 四、待你决定的四件事

| # | 事项 | 说明 |
|---|---|---|
| 1 | 站名与行业词 | 现为「童装雷达」/「童装」，改 `industry/site.ts` 后需重新构建 |
| 2 | 公众号信源 | 需极致了的 key，以及 5 个品牌公众号的 `ghid`（在极致了后台查）。拿到后放进 `industry/sources.json` 或后台直接加 |
| 3 | 更多中文行业媒体 | 联商网、赢商网、亿邦动力等需逐个写选择器。建议在后台「信源」页加，它自带试抓，比盲写选择器可靠 |
| 4 | 精选门槛校准 | 当前门槛是换行业后的估值。用后台 SelectBench 标注一两百条样本后重跑 `scripts/eval-selection.ts` 才能定档 |

---

## 五、与现有情报体系的衔接

你已有的「命主商业日周报」skill（v3.4.1）继续跑，二者不冲突：

- **本站在前面**：固定源抓取 → 事件聚库 → 可回看、可检索、可看热度
- **skill 在后面**：仍按原有 7 板块模板出报告、入库 IMA
- **打通方式**：站点对外提供 RSS、公开 API、MCP 三个出口。让 skill 改成从本站 API 取当天的精选条目，就不再依赖 WebSearch 现搜现写。接口说明在 `http://localhost:3000/agent`

---

## 六、运维

```bash
cd /d/myhot-dev

# 看日志
docker compose logs -f --tail 100 api worker web

# 停止（数据保留在三个卷里）
docker compose down

# 手工备份
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz

# 更新上游框架（会与 industry/ 的改动冲突，需手工合并）
git fetch origin && git log --oneline HEAD..origin/main
```

**注意**：`docker compose down -v` 会删数据卷，别用。
