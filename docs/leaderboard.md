# 排行榜（童装品牌榜 + 全国商业体榜）与 Codex 重置监控

排行榜模块在本档（童装雷达）为两榜体系（zw12 改造，2026-10）。别的行业在 `industry/features.ts` 里关掉即可（见 [把它改成你的行业](customize.md#6-只对-ai-有意义的两个模块industryfeaturests)）。

## 排行榜（`/leaderboard`）

两张月度榜：**童装品牌榜**（声量 20% / 业绩 40% / 规模 30% / 扩张 10%）与**全国商业体榜**（客流 35% / 童装业态亲和 20% / 业绩 15% / 首店快闪 15% / 媒体声量 15%，业绩缺数滚给客流）。权重为命主定稿，方法对读者公开：

- `/leaderboard/rules`：排名怎么算（weighted v1，维度归一加权；含防扭曲机制与冷启动标注）。
- `/leaderboard/sources`：每个数据来源的口径、状态与是否参与计分。

**更新**：每天 02:05、08:05、14:05、20:05 各跑一轮（抓取→快照→计算）。指标数据没变的轮次不发布新榜单；某个来源抓取失败时沿用它上一份快照。新装好的站在 worker 第一次启动时会立刻算一轮。

**数据面**（三端一备）：

| 来源 | 内容 |
|---|---|
| `internal-signal` | 站内声量引擎：近 30 天文章标题对品牌/商场的提及与事件计数 |
| `manual-supplement` | 人工补录通道：业绩/门店数/社媒指数/客流层级，`database/seeds/lb-brands-2026-10.json` 与 `lb-malls-2026-10.json`，改文件后下一轮刷新生效 |
| `dailyhot` | 热搜哨兵（可选）：自部署 [DailyHotApi](https://github.com/imsyy/DailyHotApi) 实例，`DAILYHOT_API_BASE` 环境变量注入后激活，未配置时停用不报错 |
| `winshang-monthly`（预留） | 赢商人气榜：公开面实测不可抓（m 站数据栏目为文章流、大数据子域不可达），接入前商场榜降级为「客流单源直榜」（人工客流层级种子） |

**实体名录**：品牌 19 家、商业体 ~112 家（全国头部+杭州重点加权），在种子文件里维护；中文名自动预写进各指标源别名表。名录外实体不凭单条消息上榜。

**防扭曲**：维度内指标均分维度权重（单源封顶）；提及类指标窗口（30 天）内不足 3 条不计分；有效维度权重占比不足 30% 的实体标「样本不足」不进正式名次；P0/P1/P2 监控分级只做页面分组不进权重。

**代码**：

| 位置 | 内容 |
|---|---|
| `packages/backend/src/leaderboard/source-registry.json` | 两榜来源登记：分组、状态、口径说明 |
| `packages/backend/src/leaderboard/fetch/sources/` | 读取器（manual-supplement / internal-signal / dailyhot；v15 时代的 AI 评测读取器保留未注册） |
| `packages/backend/src/leaderboard/method/weighted.ts` | 两榜权重正本与计算（`METHOD_VERSION`） |
| `packages/backend/src/leaderboard/method/v15.ts` 等 | 上代 Kemeny 方法，保留未引用，可回滚 |
| `apps/web/app/features/leaderboard/`、`apps/web/app/routes/leaderboard*.tsx` | 页面 |
| `industry/prompts/leaderboard-data-read.md`、`report-research-caliber.md` | AI 解读层口径（依赖 `LLM_API_KEY`，未配置时不激活） |

**工具**：

```bash
node --env-file=.env scripts/lb-round.ts --fetch      # 立刻抓一遍并算一轮
node --env-file=.env scripts/lb-round.ts --force      # 不比较指纹，强制发布一轮
```

**改方法**：`weighted.ts` 里的每个常数（权重、门槛、事件词表）都是方法的一部分，改了会改变读者看到的排名。改方法时，把 `/leaderboard/rules` 页面上的文字一起改掉，并升方法版本：页面上写的必须和实际算法一致。

## Codex 重置监控（`/codex-reset`）

盯 OpenAI Codex 团队的 Tibo（X 账号 @thsottiaux）发布的 Codex 用量重置消息：预告、进展、确认完成、撤回，给出预计生效时间和原帖链接。机器可读的接口是 `/api/v1/codex-resets`。

- 需要 `SOCIALDATA_API_KEY` 读 X。没有这个 key 时监控不运行，页面上只会显示“暂无重置记录”，这种情况建议把模块关掉。
- 平时每 5 分钟看一次，有预告或故障时 3 分钟一次；每天 04:40 再回看过去 48 小时补漏。
- 帖子由模型识别（`MONITOR_MODEL`，默认用默认模型），但状态怎么变由代码决定：模型的措辞本身不能确认任何事。
- 拿不准的识别会停在后台“Codex 重置”页等人看，可以改归属、补充、撤回。
- 配置了飞书内容推送时，重置预告和确认会推送到群里。
