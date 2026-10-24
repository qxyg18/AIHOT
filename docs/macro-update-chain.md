# 宏观月度序列自动更新链路（ym770）

数据源、班次与失败面。决策依据：决策板 `d-radar-macro-monthly-auto`，命主 2026-10-21 21:20 拍
**opt-auto（全自动抓取统计局序列）**。本链路只负责把**统计局月度发布页**变成 `macro_observations`
的新行；年度序列（出生人口、童装市场规模、年龄结构）仍是人工/公报口径，不在此列。

## 1. 数据源

| 项 | 值 |
|---|---|
| 发布列表页 | `https://www.stats.gov.cn/sj/zxfb/` |
| 发布页 | 列表页中标题匹配 `YYYY年1—M月份社会消费品零售总额增长` 的最新一条 |
| 取样字段 | 社零当月值/同比、社零 1—M 月累计值/同比、限额以上「服装、鞋帽、针纺织品类」当月值/同比与 1—M 月累计值/同比 |
| 落库 | `macro_observations`（`retail` / `apparel`，`quality='published'`）+ `macro_indicators` 的 `ytd_*` |

1—2 月发布页把两个月合并公布：没有独立的 2 月数字，合并值按种子既定口径落成 `seq=1`、`period='1–2月'`。

## 2. 班次与入口

| 入口 | 触发 | 行为 |
|---|---|---|
| worker `macro.refresh` | 每日 07:25（Asia/Shanghai，`missed=once`） | 抓最新发布页；有新月份或官方修订才写库 |
| `scripts/fetch-macro.ts` | 人工 | 缺省 dry-run（只抓取+解析+打印，**不连库**）；`--apply` 才写；`--url=<发布页>` 可回放指定页 |

统计局通常在每月 15–19 日发布上月数据。每日幂等拉取的代价是零 token、一次 HTTP；比按发布日猜点更稳，
发布日漂移不会漏月。

## 3. 幂等与防回退

- 行身份 = `(indicator_key, year, seq)`，`ON CONFLICT DO UPDATE`；同页重复运行无变化即零写入。
- 解析出的 `year*100+seq` 若小于库内该指标的最大值，**拒绝写入**（`status=stale`）：回放旧 URL 不会把月度面推回过去。
- 同月份重跑允许刷新数字（官方修订），`note` 里带发布时间。

## 4. 失败面

| 失败 | 处置 |
|---|---|
| 列表页 404 / 无匹配链接 | 抛错，`job_runs` 记红，库内数据不动 |
| 发布页缺少累计句 / 当月句 / 年份 | 解析器抛错（全量解析通过后才开事务），零半截写入 |
| 表格无服装行 | `apparel` 记 null，只写社零，结果对象 `warnings` 显式标注 degraded；下次发布再补 |
| 统计局改版 | 解析器报错即停；人工用 `--url=<新页>` 验证后修解析器，不临时改库 |

## 5. 手工兜底

```bash
# 只解析、不连库（排障/发布会先看数）
node --env-file-if-exists=.env scripts/fetch-macro.ts

# 补跑（写入，需能连到活库）
node --env-file-if-exists=.env scripts/fetch-macro.ts --apply

# 回放指定发布页
node --env-file-if-exists=.env scripts/fetch-macro.ts --apply --url=https://www.stats.gov.cn/sj/zxfb/202610/t20261019_1965614.html
```

回滚（只针对本链路写入的两类行/字段）：按 `(indicator_key, year, seq)` 删除对应观测行，并把
`macro_indicators.ytd_*` 改回上一期值即可；历史行不做删除。

## 6. 取数验证锚点

2026-09 发布页（2026-10-19）解析结果：社零当月 42433 亿/同比 1.1%、1—9 月 370001 亿/1.1%；
服装类当月 1213 亿/1.2%、1—9 月 10824 亿/4.6%。同解析器对 2026-08 页回放得到 39824/0.4、
327569/1.1、1013/-0.5、9615/5.1，与手工种子逐值一致（见 `tests/macro-nbs-parse.test.ts` 的夹具与
`artifacts/2026-10-24/ym770-macro-auto/` 的实跑记录）。
