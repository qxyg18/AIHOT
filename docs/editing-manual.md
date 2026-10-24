# 童装雷达联动编辑说明书 v1.0

2026-10-04定稿，诊断采样为2026-10-03。这是本轮交付的施工规范；安装到仓库和自动化检查由“编辑联动”卡承接。当前站点尚未具备下述全部检查能力。适用仓库 D:/myhot-dev；HUB 仍是任务、决定和收口的权威。

本说明书描述未来授权建设/运行方职责。当前Codex仅按codex-card-issuance-protocol v1.2发提案卡和只读查验，不执行此处施工、认领、收口、决定回填、共享资产编辑或广播。不得因阅读此说明书扩大Codex写权限。

站点服务命主与内部渠道团队，帮助判断品牌和商业体机会、开闭店与合作。信息输出必须区分已核事实、报道、估算、推断、待核线索。不得把排名、媒体声量、同文共现直接改称合作价值、客流实测或已经入驻。

## 1. 每次编辑的完成定义

完成单位是一个业务变化及其全部消费者。不能以“我的文件改完了”收口。

1. 读仓库 AGENTS.md、此说明书、所涉领域原本、HUB 卡、关联未决事项。
2. 冻结实际 HEAD、dirty diff、涉及文件 SHA256、当前运行镜像与配置版本；只记录允许公开的配置键，不复制凭据。
3. 从变更根查影响图的传递闭包，列出实际需要修改、需回归但不用修改、明确不适用三类；“不适用”必须写证据和原因。
4. 在卡上申请互斥文件或明确不交叉的 hunk；共享文件单 owner。任何不在清单内的变化先停，再升版方案。
5. 代码、类型、规则、接口、页面、提示词、派生数据、文档、测试和发布配置按影响闭包一起完成。派生数据重算另有有界计划与回执。
6. 先验证反例，再验证正常路径、公开出口、页面一致性与资源上限；缺证据的状态叫“未验证”。
7. 独立审计完整变更包。低风险满足第 5 节后可自动发布；高风险进入现有 HUB 决策看板，待命主决定。
8. 按变更身份整体部署和观察，归档证据、回滚范围与结果；每卡最后一步固定“审计任务结果”。

任何一环缺失，状态是 blocked/parked 或待证据，不得标“已完成”。HTTP 200、类型通过、存在模块、模型目录列出免费、任务已建，都不是生产验证通过。

## 2. 权威与运行边界

| 内容 | 权威 | 消费者 |
|---|---|---|
| 经营目标与授权 | 用户原话 + HUB 有版本确认的范围 | 本地工作画像、方案、任务与决策 |
| 排名算法 | weighted.ts 的方法版本和本轮 run/snapshot | 规则页、信源页、两榜、子榜、详情、llms.txt |
| 文章公开状态 | publications 与公开读取层 | 首页/all/hot/item/story/entity/topics/report/feed/sitemap |
| 文章内容版本 | material/article revision 与输入 hash | 观点、深读、实体、日报和模型回执 |
| 信源状态 | sources；候选生命周期扩展后由候选证据 CAS 对接 | 采集、后台质量、自动启用、隔离与 republish |
| 模型调用 | receipts/receipt_attempts + 预算 + 能力认证 | 业务分析、探针、回填、免费路由 |
| 建设任务与拍板 | HUB SQLite + data/decision-board/queue.json | 自治提案、执行器、发布与看板投影 |

站点 pg-boss 管站内数据作业；HUB 管建设与审批。自治不得另开一套任务完成状态、第二调度权威或自己的“已批准”表。站内仅保存 HUB task/decision/release 的引用与投影缓存，缓存过期展示 stale，不推测批准。

## 3. 变更影响矩阵

下表是最小闭包，实际符号见 cards.json 和 full-site-audit.md。所有相对路径以 D:/myhot-dev 为根。

| 编辑根 | 必须联动的检查/编辑面 | 专项反例 |
|---|---|---|
| 榜单规则、权重、断点、缺数、成色 | leaderboard/method/weighted.ts → 本轮 snapshot/methodology → leaderboard/read.ts → source-registry.json 的非运行元信息 → contracts/src/leaderboard.ts → leaderboard/rules、sources、source/:key、两榜、sub/:sub、:slug → llms.txt → docs/LEADERBOARD.md/changelog/测试 | 品牌/商业体同 familyKey 不能串源；退役维不显示在役权重；无 run/部分源覆盖/同分/低覆盖 |
| 榜单只改说明纠错 | 仍需上述闭包回归，但不能偷偷改算法、历史 run 或业务口径；说明必须从当前 run 派生 | “描述修复”前后排名、分数、methodology hash 完全相同 |
| 实体名录、别名、主体关系 | 种子/entity profiles → 实体解析 → entity tags/signals → 采集包含词 → 榜单和实体页 → 检索/过滤/报告 → 缓存/证据版本 | 同名品牌、好孩子与孩子王、集团与单体、同名商业体、共现不是入驻 |
| 日期、标题、摘要、正文、译文 | sources/collect → content/materials → publication/timeline/publish → story signals/聚簇 → insights/deepread 版本 → feed/search/entity/report → 原文链接/缓存 | 旧 URL 缺日期、多轮详情预算、未来日期、同日无精确时间、旧热度撤除、人工修改冲突 |
| 分类、选择门槛、评分 | industry/taxonomy/selection → contracts → prompts/analyze → publications → 首页/all/hot/macro/topics/entity → 日报候选与配额 → about/说明/测试 | blocked 正常拒绝与失败不能混淆；未知类别不发布；六类名称全站一致 |
| 信源新建、权利、过滤、启停 | source config/types/config-keys → parser/probe → admin/create/update/audit → sources.schedule → 公开渠道与 republish → 官方根/候选证据 → monitor/质量页面/模块文档§8 | 同 endpoint 并发、跨 kind 同源、重定向离域、robots 失败、手动退役不可自动复活、正常304/低频无新增 |
| 观点/深读提示词与模型 | prompt/input hash → receipt key → 有预算模型调用 → CAS/事务写入 → 公共读取有效版本 → sweep/backfill eligibility → UI空态 → 成本与故障证据 | 第二条 INSERT 失败旧结果不丢；模型期间 revision 变更不覆盖；unknown不换模型重试；无进展有限退出 |
| 日报规则与文章审核 | reports/compose + industry/report → report schema/API → 页面头条/看点/正文/档案 → 文章撤回传播 → prompts与审核用例 → 时刻/配额说明 | 头条与正文货币、周期、同比基准不同；同事件两文不叫两件大事；撤回后不残留摘要；没有渠道证据不输出行动承诺 |
| UI组件、样式、布局 | 共享组件/root/style → 所有调用路由 → 桌面/窄屏、深浅色、键盘、空态/错误/加载态 → 搜索/收藏/导航/打印 → 可访问性证据 | 表格横溢、焦点丢失、对比度、长标题、详情/原文 loader 形状、无数据不伪显示排名 |
| 路由、loader、API类型 | apps/web/app/routes.ts → route loader/action → contracts与API端点 → 复用组件必需 props → 内链/面包屑/规范URL → smoke/SSR/404/鉴权 | item-original 复用详情缺 entities；合法 mall 主板被误当 brand；无管理员会话不得判后台操作通过 |
| 模型免费窗口、路由、额度 | modelwatch/catalog/store/monitor/routing → editorial/models → providers/llm/receipts → admin/runs recovery → 能力认证、预算、数据政策 → 后台状态/告警/操作说明 | 价格变正/目录过期/非文本模型/缺预算/配额耗尽/unknown/Busy；免费路径不得落付费模型 |
| 队列、cron、资源配置 | jobs/queue/sources/content/publication → worker/main/schedules → operations/reports → receipts/budgets/重试 → Docker发行与回滚 → HUB维护卡 | 调度暂停不等于在途暂停；COLLECT=false仍排无人消费任务；超时/重启/容量不足有界停车 |
| 自治政策、审计和发布 | 版本政策 → HUB task spec/actor/lease/独立审计 → 决策看板 → release manifest/变更范围 → 健康观测/回滚/收口 → owner-visible投影 | 实施者不能审计自己；未知影响不得降风险；混入他人dirty变更；没批准不得发布；同 proposal 重放不双发 |
| 用户工作画像 | 用户已确认字段+来源+有效期 → 私有关注/地域筛选 → 机会表达与评价样本 → 本地决策面 | 私有名单/经营数据不进公开页面或外部模型；不从旧记忆猜当前合作政策 |

“联动”并非强制每次修改所有文件；它要求闭包中的每个面有明确处理结果，禁止留下无人负责的消费者。

## 4. 把说明书变成机器检查

“编辑联动”卡安装 docs/editing-manual.md、docs/change-impact.json 和 scripts/check-change-impact.ts，根 AGENTS.md 只增指向与开工流程，不重写既有指令。

影响图节点声明 owned_paths、业务根、consumer_edges、required_checks、risk_floor；图由现有代码和已确认领域关系填写，禁止靠模型临时生成后直接批准。变更包 change-manifest.json 包含：

```json
{
  "schema": "tzr-change/1",
  "task_id": "HUB UUID",
  "baseline": {"head": "actual SHA", "dirty_manifest_hash": "actual hash"},
  "changed_hunks": [{"path": "absolute path", "symbol": "verified symbol", "before_hash": "actual hash"}],
  "roots": ["leaderboard.description"],
  "impact_policy_hash": "actual hash",
  "closure": [{"node": "leaderboard.rules", "disposition": "checked", "evidence": "local artifact"}],
  "risk": "high",
  "release_id": "content-addressed manifest id"
}
```

校验器只读 baseline 到补丁的实际 diff；根由路径自动命中，再合并声明，未知路径默认高风险待归属。检查图传递闭包、循环/孤儿、缺处理项、越界 hunk、测试证据、方法/接口/提示词版本引用；无关文件不能用假 touched 勾销。

跨文件静态比对：当前 run 权重/board/family 与所有公开投影一致；页面描述不能另维护百分比副本；规则版与算法版匹配；合法链接不误404；禁用feature路由与导航/导出一致。深度行为由对应测试证明，静态一致只是必要条件。

模型可提出补丁、关系或解释，不能同时修改影响图和利用改后的图给自己放行。影响政策升级单列高风险任务与独立审计。

## 5. 自治风险和发布资格

用户已授权“低风险修改审计通过可自动发布；高风险等我定夺”。无需对已授权的低风险动作重复询问，但必须验证每个实际发布包落在下列资格中。

| 风险 | 首期资格 | 处理 |
|---|---|---|
| 低 | 已核事实/当前计算不变的错别字、普通内链修复；既有共享组件的局部非语义样式修复，且不改变交互、可访问性或信息排序；被完整用例覆盖的说明同步 | 范围校验、影响闭包、独立审计、构建与回归、可撤发行包全部通过后自动发布 |
| 高 | 排名口径/业务阈值、事实修改或撤回争议、文章行动判断、分类/配额/筛选语义、schema/公共API、身份权利与政策、权限条款、外发、账号/费用、模型数据政策、资源与运行权限、自治策略本身 | 先准备可复核差异与证据，再登现有HUB看板；批准后施工/发布 |
| 未知 | 消费面不明、费用/外部结果不明、审计冲突、既有dirty归属不明 | 停车补证据，不重试、不自动降成低风险 |

首批底层修复和自治底座本身按高风险治理。待这些底座通过审计，后续合格低风险包可按用户授权自动发布。不存在“整页UI都是低风险”或“用免费模型就不需要预算”的捷径。

发布包必须绑定实际源码 patch、依赖锁、可部署产物、方法/政策/提示词版本、被审计内容 hash、owner、回滚包。本站 dirty 很多，禁止把完整当前目录打包为已审小补丁；必须隔离构建从冻结基线和授权 hunk 生成的发行物。API/worker/web一并核对该包需要的运行文件 hash，避免docker cp造成不明混版。

G00逐卡区分BUILD_READY与ACTIVATE_READY：前者为完整已审允许面/依赖/构建的兼容禁用态产物，后者另需启用政策/证书/额度。无新源/免费模型样本不拖已核普通修复；不能用全局ready或他卡证据放行。每个可部署小批经独立发布前审计，持久intent→授权发布→回执→运行hash/受影响出口→≤72h观察→末步结果审计，不等待最终T12。纯未接线组件用有证据N/A交明确消费者，不能冒称上线，也不强制每卡独立部署。

T19先用既有published事实与本地确定性/人工审核，不等T05/T15/T16/T17；T06B先注册后台机会，T06后接数据作业，T17完成自治组件/接口后T06C再注册。三张接线卡共享一个integration owner，串行复核后置hash。未注册route不得提前引用不存在的React Router生成`./+types/*`，先采用已冻结DTO与可独立typecheck的组件/loader签名；B/C接线产生正式路由类型。每个中间状态也必须typecheck/build通过。

预览通过后才发布；发布后关键路由、API与公开可见性恢复，资源无红线，最多72h观察。接口兼容、曝光、费用或硬不变量失败立即撤回该包，既有业务数据不删。低频信源样本不足叫“待样本”，不伪报72h可靠性通过。

## 6. 文章审核与经营表达

文章证据至少包含主体、事件/指标、值、单位/币种、周期、地域、同比/汇率口径、来源URL、发布日期和摘取位置、事实/报道/估算/推断标签。来源存在冲突时并列记录，不平均造结论。

日报必须从已审核事实生成头条、看点、正文的同一事实引用，不通过再次自由摘要改变货币/时间。22%与26%可以分别代表不同汇率口径，必须保留基准，不能强行视作矛盾；£与$不能跨段当同一单位。缺口径时删去该数字或转待核，不能猜补。

经营输出依次回答：发生什么 → 对哪个区域/品牌/商业体可能有影响 → 可核证据与反证 → 还缺什么 → 团队可采取的下一步核验。宏观奢侈品增速不单独支持某童装品牌调价/扩店建议。未经核验的合作建议作为待核线索，不能写成指令。

首期新增“机会/风险线索”只在鉴权后台展示，沿用现有品牌与商业体名录，使用现有entity/story/report/publication：展示实体、区域、开闭店/合作事件、时间、独立来源、证据成色、缺项、建议核验、HUB承接引用。不开新的合作价值评分；有效性经内部团队验证并经命主决定后，才另发前台发布卡。

戴维贝拉入驻底账从DB分析店仓档案只读导入最小字段，不复制联系人、POS密码、经销商财务或会员字段。实际档案无标准商业体ID/商业体名称专列，需要按城市、店仓名称和经审核别名建立mall slug桥。同名不同城市、改名/转让、多主体节点、店中店/集合柜、未来开店、已闭店、品牌归属不明均进入待核队列，不能凭模糊分数自动标“已入驻”。“当前已确认在营”“历史曾入驻”“计划开业”“待核”“未检出档案”分开保存；未检出不等于未入驻。

机会搜寻在既有商业体名录中展开：已确认在营标注并排出纯新增招商清单；历史退出保留复入/风险核验；未确认项先补证据。候选展示当地儿童/家庭消费、品牌/项目定位、租赁/招商与开店信号、现有竞争组合、信息新鲜度和关键缺项。缺租金、可出租铺位、招商意向或实际客流时不宣称适合签约。模型只可总结公开材料；内部入驻桥不外发，后台结果不进feed/sitemap/llms/公开API。

审核结果持久化并绑定输入hash/revision；通过才可生成本次新日报，撤回由原publication层传播到日报、故事、实体、搜索与导出。旧报告修改是单独受治理操作，保留历史版本与理由。

## 7. 信源与免费模型的持续运营

官方信源在已核验根和免费公开范围内发现，独立检查身份、权利、域/robots、解析、日期、实体/渠道相关度和健康；准入参数由标注样本校准，有版本和负责人。未冻结参数时自动启用关闭。候选与人工退役信息持久化，重复执行同candidate/policy/config/proof只返回同结果。

免费模型目录不是能力证书。每项能力按实际schema、中文事实、引用、异常、时延和配额样本认证，保留dataset/prompt/model/provider/policy版本。非文本或不满足能力的模型仅陈列。首期不创建账号、充值、绕限、扩大数据授权或把HUB私有记忆发出。

入选免费模型标准（2026-10-13 命主核定，替代 2026-10-02「上下文 ≥1M 启用线」口径）：①上下文闸放开——不足 1M 上下文的免费模型允许加入观察与实测，不再因上下文长度仅陈列；②去留以实测质量决定——能力实测（schema、中文事实、引用、异常、时延、配额样本）与生产实跑质量合格者进路由，不合格者退回陈列或退役，观察期质量数据留痕；③探索常态化——持续探索更多免费模型补充进池（承接=周期卡 ym561，代码面落地=ym560）。

所有探针和业务请求走同一回执/预算。免费策略必须把provider价格上限置零，禁止收费fallback；目录价格字段缺失、过期、额度未知、预算缺行、unknown结果时暂停并呈现原因。通用请求失败只有明确未被提供者接收的可重试失败才考虑有界退避；Busy、Budget和Unknown不能触发切换模型。

同一成功回执在业务写入失败时复用，不重新花token。费用为0但token/RPM/TPM仍受资源上限；日志记录摘要和hash，不记录凭据、私有经营数据或完整共享记忆。

## 8. 资源与自治迭代闭环

循环为：采样/全站审核 → 证据和缺口 → 有界提案 → HUB查重与建卡 → 分类/决定 → 独立施工与审计 → 发布 → 观察 → 接受或回滚 → 更新本地知识与影响图候选。图政策与工作画像更新本身受治理，不自行改写命主授权。

首期自检产生提案与低风险修复包，HUB已有执行器认领建设任务；不在worker进程运行一个无限自治编码agent。不启动新的外部账号和第二daemon，不擅自关闭归属未知的容器。

内存/CPU/队列/缓存/DB/token/预算一同记录。先做同负载前后基线，才谈优化收益；按任务/能力/源统计有效输出成本。设置可版本化并发、每轮候选/探针数、最大输入输出token、作业墙钟、缓存有效期、退避上限和保留周期，阈值需要既有配置或校准证据。阈值缺失关闭新自治动作，不用无限额默认。

压力到达限额时优先暂停低优先探索与非必要回填，保留读站能力和已持久回执；unknown停车。后台呈现 defined/enabled/active/verified/stale/unknown对应中文状态“已定义/已启用/运行中/已验证/已过期/未知”，不能用一个绿色圆点覆盖全部含义。

命主决策面只投影现有 HUB queue.json：问题、证据、两个以上具体选项、收益/风险、推荐、承接任务、触发条件与决定史。未来发布预约 suspended；事实包齐备再 pending。已答复的经营目标、免费来源范围、观众和风险授权写入已决定记录及承接，不重复问。

## 9. 施工、验收和回滚模板

每卡写唯一目标、冻结输入、允许面/禁区、精确path/symbol/hunk、原子步骤与预期、反例AC、abort、幂等级别、回滚和遗留处置。代码未勘明的卡只发行DISCOVER/PLAN，EDIT步骤不得交给施工者自由架构。

隔离新建 *_test/*_ci DB + stub + 所有收费/采集/推送/SEO阀关闭；不得在生产跑测试或占用他人15432测试桥。npm run typecheck与受影响测试之后，再跑所需完整不变量、web build/SSR smoke；没有新故障不要反复无目的重跑。

回滚只撤本卡hunk，先核对post-image/CAS，禁止整文件恢复、reset或删除业务表；迁移兼容字段保留。公开事实修复按逐条before/after补偿，若已被他人改动立即停止。回滚应能在原发布观测里复验。

结果包固定返回 status、summary、acceptance_results、evidence、changed_files、limitations；结果审计和任务审计要对应同一发布hash。v2_native卡使用完整spec→Run→Result→Audit→complete_task；审计广播payload.audit引用真实独立结论。遗留项按task-closeout-protocol现行v1.16登记决定/承接任务/明确处置。

## 10. 全站覆盖与说明书维护

每次全站扫描从 routes.ts 和 API/public export端点生成清单，对参数路由用存在的样本、无效样本和空态，禁止猜不存在的ID。公共GET、视觉、交互、后台鉴权和生产观测分别计覆盖。后台未登录不能称全站操作PASS；本轮后台仅静态读取，无后台动作。

浏览器至少检查共享壳、首页/all/hot、日报与档案、品牌/商业体榜与各详情、规则/来源、实体/文章/原文、macro/topics、about/more/legal/feedback、空态/404；窄屏与键盘在隔离预览另验。搜索/收藏/反馈要区分本地可逆动作和生产提交，反馈写操作使用隔离站。

新增模块必须登记业务根、消费者、公开/后台入口、鉴权、失败空态、预算/外部副作用、测试和维护owner；未登记的新增节点默认不允许自治发布。文档随版本维护，独立审计核对说明与实际代码；不能仅更新说明宣称检查器已上线。

本次54叶路由是诊断基线，验收必须按当次routes.ts、API与导出重生成全集，包含新增后台入口及鉴权反例。钢人修订卡包24卡/90初始面；未列测试/fixtures/evals/schema导出/新迁移由G00实读补全、分配owner并独立审计后才可EDIT，未补齐禁止该卡ready。baseline.json为早期诊断，card-baseline.json为晚期卡面快照；外部变动归属未知时停下重核，不能把晚期hash视为对旧缺陷仍成立的证明。


团队查看与建设操作分权由T20承接：服务端批准的grant/cap权威；未知身份缺grant不升operator；feedback仅待核且CSRF，confirm另批。导航隐藏不是权限，viewer直调源/模型/设置/预算/发布API须403，撤权后旧session后续请求也拒绝。名单未批只挡TEAM_ACTIVATE，不拖既有已核operator MVP，不自行建账号或授权成员。auth.ts由T20→T04同AUTH owner串行。

发卡v1.2通过depends_on_task_ids自动登记task_done AND依赖闸；执行方只读核验，不再自登。逐卡BUILD_READY/ACTIVATE_READY与团队启用等额外等待须在owner_order关闭时由授权执行方补齐，不能用正文或另一卡ready代替。最终独立冻结审计与实际启用证据仍是施工硬闸。

## 准备信号与发行边界补充

HUB现行dir_has_file只判断任意文件存在。禁止将其绑定含本说明、日志、证据或临时文件的目录；每卡/批次/封印hash使用独立空signals目录，经独立冻结校验后仅原子落release-packet.ready，临时写在目录外。运行前再比base/patch/policy/审计hash；过期先撤信号并停。BUILD不是自动启用或团队授权许可，ACTIVATE/TEAM仍受服务端版本化证据和批准。新设计按task-card-authoring-protocol §八逐卡附ADR-lite，风险/影响图本身由独立审批维护。

依赖卡被认定已修或批准销案时，不将标签当作completed。实际完成按独立证据及HUB原完成链；改道需批准后调整实际机器闸并重冻结。发行通道使用维护方最新v1.3；Codex只发行候令提案和只读核账，不认领、放行、执行或收口。

## 安装附注（TZR-20261003 T14/ym247）

本节是安装时（2026-10-04）追加的仓库内指针，正文 v1.0 以上为诊断正本逐字节安装；修改正文须另立任务并回写诊断正本。按 G00 冻结接口补实际符号：

- 影响图正本：`docs/change-impact.json`（schema `tzr-impact/1`，初版 2026-10-04 安装）。§3 矩阵十三业务根 + 共享契约根均已建节点，`owned_paths` 为目录/文件前缀匹配，未命中任何 owned_paths 的路径按未知默认高风险。
- 只读检查器：`node scripts/check-change-impact.ts --manifest <change-manifest.json>`（§4 的 manifest schema `tzr-change/1`）。检查器与影响图政策文件本身受自放行禁令保护：普通变更的 diff 触及二者即 FAIL；政策升级（tzr-impact/2+）另立高风险任务并独立审计。
- 宏观共享 DTO 正本：`packages/contracts/src/macro.ts`（T01/ym239 冻结；`packages/backend/src/macro/read.ts` 原样再导出；web 路由 `apps/web/app/routes/macro.tsx` 与 API 路由 `apps/api/src/routes/macro.ts` 均消费本契约，不各自维护镜像）。
- 卡面/逐 hunk 哈希与 24 卡 DAG：诊断产物 `D:/agent-hub/artifacts/2026-10-03/tongzhuang-radar-diagnosis/`（cards.json / card-baseline.json / full-site-audit.md；HUB 侧只读引用，不复制）。
- 说明存在不等于检查已启用：本仓库的自动核验目前只有 check-change-impact 的 manifest 校验与既有测试/typecheck/build；§4 的跨文件静态比对、深度行为证明按各卡验收面逐步接线。
- 首版语义边界（跨族终审 2026-10-04 判定，tzr-impact/2 前如实生效）：①manifest.checks_run 是**声明面**——检查器核对闭包节点的必备检查已登记且登记值为 exit 0，但不重跑命令，独立核验在审计端；②closure 的 checked/n_a evidence 是**在盘性证明**而非内容证明（文件存在≠内容相符，内容级核验归独立审计）；③external 声明仅用于他方在途件：每条须带 owner≠本任务，路径须可归属影响图；图外路径仅在 manifest 显式 external_policy=allow_unattributed 且 risk=high 时放行，并计数披露（未知待归属必须响亮，不得借 external 静默绕过未知路径 fail-closed）。
