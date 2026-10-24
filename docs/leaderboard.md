# 排行榜（童装品牌榜 + 全国商业体榜）与 Codex 重置监控

排行榜模块在本档（童装雷达）为两榜体系（zw12 改造，2026-10）。别的行业在 `industry/features.ts` 里关掉即可（见 [把它改成你的行业](customize.md#6-只对-ai-有意义的两个模块industryfeaturests)）。

## 排行榜（`/leaderboard`）

两张月度榜：**童装品牌榜**（业绩 50% / 规模 30% / 媒体声量 20%，扩张维度已取消）与**全国商业体榜**（业绩 50% / 客流 30% / 媒体声量 10% / 童装业态亲和 10%，首店快闪维已取消；业绩维度整体缺数时滚给客流）。权重为命主定稿，方法对读者公开：

- `/leaderboard/rules`：排名怎么算（weighted 方法，现役版本以页面方法版本号为准（当前 `2026.10-weighted-v4.8`），维度内归一按定稿权重加权；含防扭曲机制与数据置信级披露）。**每轮计算把各榜「本轮在役维度 + 计分分母（在役权重和）」随 run 落库**——规则页权重表、来源页参排状态、两榜/子榜/详情页说明均从同一份 run 数据投影（T13 修复：规则页来源按 board 归属过滤不串源、商业体详情按商业体榜口径显示名次、`/llms.txt` 与两榜口径一致），页面不另维护权重百分比副本。
- `/leaderboard/sources`：每个数据来源的口径、状态与是否参与计分（「参与排名」由本轮计算结果派生，与算法同源；已退出在役维度的来源（如 v4.6 取消的首店快闪维）显示为「仅供参考」，事件词采集面保留不参排）。

**更新**：每天 02:05、08:05、20:05 各跑一轮（抓取→快照→计算；14:05 轮已随 zw20 低峰计划移除）。指标数据没变的轮次不发布新榜单；某个来源抓取失败时沿用它上一份快照。新装好的站在 worker 第一次启动时会立刻算一轮。

**数据面**（三端一备）：

| 来源 | 内容 |
|---|---|
| `internal-signal` | 站内声量引擎：近 90 天文章（标题+摘要+正文全文）实体标注计数，窗口按发布时间口径 `coalesce(published_at,discovered_at)`（ym842 统一，d-ym160-window-field 拍板乙；此前按入库时间线 `timeline_at`，rd7 既有差异，对拍现势零差异）；首店/快闪事件按标题事件词过滤 |
| `manual-supplement` | 人工补录通道：业绩/门店数/社媒指数/客流层级，`database/seeds/lb-brands-2026-10.json` 与 `lb-malls-2026-10.json`，改文件后下一轮刷新生效 |
| `dailyhot` | 热搜哨兵（可选）：自部署 [DailyHotApi](https://github.com/imsyy/DailyHotApi) 实例，`DAILYHOT_API_BASE` 环境变量注入后激活，未配置时停用不报错 |
| `winshang-monthly`（预留） | 赢商人气榜：公开面实测不可抓（m 站数据栏目为文章流、大数据子域不可达）。机器客流源缺席期间商场榜客流维由人工客流层级种子以「人工种子」档参排（rd4 起不降级直榜），机器源接入后自动升档覆盖种子值 |

**实体名录**：品牌 61 家、商业体 419 家（全国头部+杭州重点加权），在种子文件里维护；中文名自动预写进各指标源别名表。名录外实体不凭单条消息上榜。

**防扭曲**：维度内指标均分维度权重（单源封顶）；提及类指标窗口（90 天）内不足 3 篇不计分；有效维度权重占比不足 30% 的实体标「样本不足」不进正式名次；各维度独立计权，实体缺数维度计 0 贡献不交叉补位，缺营收先按同条件组中位数填一层「推断填充」值（0.5 折价）；营收/门店/商场营收按定稿断点分层锚点绝对计分（品牌营收 3/5/10/20 亿、门店 200/600/1000 家、商场营收 10/20/50/150/200/250 亿）；维度分按数据成色折价后进加权（机器源 1.0 / 研报提取 0.85 / 人工种子 0.7 / 推断填充 0.5）；全榜空转的维度滚出权重体系、权重按比例摊给其余在役维度；P0/P1/P2 监控分级只做页面分组不进权重。

**代码**：

| 位置 | 内容 |
|---|---|
| `packages/backend/src/leaderboard/source-registry.json` | 两榜来源登记：分组、状态、口径说明 |
| `packages/backend/src/leaderboard/fetch/sources/` | 读取器（manual-supplement / internal-signal / dailyhot；v15 时代的 AI 评测读取器保留未注册） |
| `packages/backend/src/leaderboard/method/weighted.ts` | 两榜权重正本与计算（`METHOD_VERSION`） |
| `packages/backend/src/leaderboard/method/v15.ts` 等 | 上代 Kemeny 方法，保留未引用，可回滚 |
| `apps/web/app/features/leaderboard/`、`apps/web/app/routes/leaderboard*.tsx` | 页面 |
| `industry/prompts/leaderboard-data-read.md`、`report-research-caliber.md` | AI 解读层口径（当前休眠：仓内无调用点接线，未激活；接线前须按在役方法版本复核口径） |

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
