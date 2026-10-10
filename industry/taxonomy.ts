// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。
//
// 【本档说明】面向童装零售与加盟渠道。分类按“对渠道决策有用”切，不按媒体栏目切。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "brand-moves", label: "竞品动态", section: "品牌与竞品", guide: "竞品与本品牌的经营动作：新品系列、联名与 IP 合作、代言人、订货会、旗舰店/新店型、品牌升级、渠道政策调整" },
  { key: "channel", label: "渠道与商场", section: "渠道与商场", guide: "渠道、商场与电商的一切动作：开店关店与门店数量、加盟政策与招商、经销商网络、商场开业调改与首店快闪、客流榜单、电商平台与直播、私域会员运营" },
  { key: "industry", label: "行业与公司", section: "行业与公司", guide: "行业整体与公司经营：财报业绩、融资并购、人事变动、股权与回购、合作与诉讼、展会活动、行业榜单" },
  { key: "statistics", label: "宏观与数据", section: "宏观与数据", guide: "官方统计、市场研究与研报的数据面：社零总额与服装类零售、GDP 与 CPI/PPI、人口出生率、纺织行业运行数据、原材料成本、行业规模与增速、消费趋势调研、券商研报与白皮书要点" },
  { key: "product", label: "产品与政策", section: "产品与政策", guide: "产品与合规层面：品类结构变化、面料与工艺、流行色与版型、爆款品类、功能性材料、童装国家标准与抽检、质量通报与召回、广告与知识产权合规" },
  { key: "overseas", label: "海外标杆", section: "海外与标杆", guide: "海外童装与国际零售：海外童装品牌动作、国际零售商财报与策略、可比市场的消费与渠道变化" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["product_launch", "store_channel", "company_action", "market_data", "policy_regulation", "opinion_analysis", "industry_event"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "品牌动作", "渠道与商场", "公司经营", "宏观与数据", "产品与政策", "海外/标杆", "其他",
] as const;

/** 可选的主题标签。2026-10-01 起 11 类收拢 6 类：原分类标签降级为主题标签（历史文章的主题页锚，继续合法）。 */
export const TOPIC_TAGS = [
  "加盟", "直营", "门店", "商场渠道", "首店", "快闪", "电商", "直播/内容", "私域/会员", "大促", "库存", "定价/折扣", "联名/IP", "供应链", "出海",
  "新品", "品宣", "人口/出生率", "原材料成本",
  "婴幼", "大童", "童鞋", "运动童装",
  // ── 降级标签（原 11 类时代的分类标签，保历史文章与主题页锚）──
  "商场动态", "电商动态", "统计/数据", "市场/数据", "行业研报", "产品/趋势", "政策/合规", "渠道/加盟",
] as const;

/** 可选的实体标签（公司、机构、平台）。必须与下方 ENTITIES 的显示名一致。 */
export const ENTITY_TAGS = [
  "巴拉巴拉", "森马服饰", "安踏儿童", "安踏体育", "Mini Peace", "太平鸟", "安奈儿", "起步股份", "金发拉比",
  "英氏", "moodytiger", "戴维贝拉", "孩子王", "爱婴室", "比音勒芬", "地素时尚", "李宁", "耐克", "阿迪达斯",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  竞品动态: "品牌动作", 品牌动态: "品牌动作", 新品发布: "品牌动作", 联名: "联名/IP", IP合作: "联名/IP", 代言: "品牌动作",
  渠道: "渠道/加盟", 加盟渠道: "渠道/加盟", 招商: "加盟", 经销商: "加盟", 开店: "门店", 关店: "门店", 闭店: "门店",
  财报: "公司经营", 业绩: "公司经营", 融资: "公司经营", 并购: "公司经营", 收购: "公司经营", 人事: "公司经营", 股权: "公司经营",
  数据: "市场/数据", 市场: "市场/数据", 社零: "统计/数据", GDP: "统计/数据", CPI: "统计/数据", PPI: "统计/数据",
  出生率: "人口/出生率", 人口: "人口/出生率", 棉花: "原材料成本", 统计局: "统计/数据",
  研报: "行业研报", 券商: "行业研报", 白皮书: "行业研报", 报告: "行业研报",
  产品: "产品/趋势", 趋势: "产品/趋势", 设计: "产品/趋势", 面料: "产品/趋势", 品类: "产品/趋势",
  政策: "政策/合规", 监管: "政策/合规", 法规: "政策/合规", 抽检: "政策/合规", 国标: "政策/合规", 合规: "政策/合规", 质量: "政策/合规",
  海外: "海外/标杆", 国际: "海外/标杆", 行业: "公司经营", 动态: "公司经营",
  商场: "商场动态", 购物中心: "商场动态", 快闪店: "快闪", 首店经济: "首店", 调改: "商场动态",
  电商渠道: "电商", 线上: "电商", 线下: "门店", 会员: "私域/会员", 私域: "私域/会员",
  定价: "定价/折扣", 折扣: "定价/折扣", 库存周转: "库存",
};

/** 模型漏了分类标签时，按内容类型补一个。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  product_launch: "品牌动作", store_channel: "渠道与商场", company_action: "公司经营", market_data: "宏观与数据",
  policy_regulation: "产品与政策", opinion_analysis: "产品与政策", industry_event: "公司经营",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/** 公司主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  balabala: { name: "巴拉巴拉", displayTag: "巴拉巴拉", aliases: ["巴拉巴拉", "Balabala", "balabala"] },
  senma: { name: "森马服饰", displayTag: "森马服饰", aliases: ["森马服饰", "森马集团", "森马", "Semir", "002563"] },
  "anta-kids": { name: "安踏儿童", displayTag: "安踏儿童", aliases: ["安踏儿童", "ANTA KIDS", "安踏kids"] },
  anta: { name: "安踏体育", displayTag: "安踏体育", aliases: ["安踏体育", "安踏集团", "安踏", "ANTA", "02020"] },
  "mini-peace": { name: "Mini Peace", displayTag: "Mini Peace", aliases: ["Mini Peace", "MiniPeace", "太平鸟童装"] },
  taipingniao: { name: "太平鸟", displayTag: "太平鸟", aliases: ["太平鸟", "Peacebird", "603877"] },
  annaier: { name: "安奈儿", displayTag: "安奈儿", aliases: ["安奈儿", "Annil", "002875"] },
  qibu: { name: "起步股份", displayTag: "起步股份", aliases: ["起步股份", "ABC KIDS", "ABCkids", "603557"] },
  "jinfa-lababi": { name: "金发拉比", displayTag: "金发拉比", aliases: ["金发拉比", "拉比", "LABI BABY", "002762"] },
  yingshi: { name: "英氏", displayTag: "英氏", aliases: ["英氏", "英氏婴童", "YeeHoo"] },
  moodytiger: { name: "moodytiger", displayTag: "moodytiger", aliases: ["moodytiger", "moody tiger"] },
  davidbella: { name: "戴维贝拉", displayTag: "戴维贝拉", aliases: ["戴维贝拉", "戴维", "david bella", "davidbella"] },
  haiziwang: { name: "孩子王", displayTag: "孩子王", aliases: ["孩子王", "Kidsland", "301078"] },
  aiyingshi: { name: "爱婴室", displayTag: "爱婴室", aliases: ["爱婴室", "603214"] },
  biyinlefen: { name: "比音勒芬", displayTag: "比音勒芬", aliases: ["比音勒芬", "Biemlfdlkk", "002832"] },
  disu: { name: "地素时尚", displayTag: "地素时尚", aliases: ["地素时尚", "地素", "DAZZLE", "603587"] },
  lining: { name: "李宁", displayTag: "李宁", aliases: ["李宁", "LI-NING", "李宁YOUNG", "02331"] },
  nike: { name: "耐克", displayTag: "耐克", aliases: ["耐克", "Nike", "Nike Kids", "Jordan Kids"] },
  adidas: { name: "阿迪达斯", displayTag: "阿迪达斯", aliases: ["阿迪达斯", "adidas", "adidas Kids"] },
  // ── 商场与商业体（displayTag:null：不占模型标签位，仅用于实体归组与主题聚页）──
  in77: { name: "湖滨银泰in77", displayTag: null, aliases: ["湖滨银泰in77", "in77", "湖滨银泰"] },
  "hangzhou-tower": { name: "杭州大厦", displayTag: null, aliases: ["杭州大厦", "杭州大厦购物中心"] },
  intime: { name: "银泰商业", displayTag: null, aliases: ["银泰商业", "银泰百货", "武林银泰", "银泰"] },
  longfor: { name: "龙湖天街", displayTag: null, aliases: ["龙湖天街", "天街", "龙湖商业"] },
  mixc: { name: "万象城", displayTag: null, aliases: ["万象城", "杭州万象城", "华润万象城"] },
  wanda: { name: "万达广场", displayTag: null, aliases: ["万达广场", "万达商业"] },
  wuyue: { name: "吾悦广场", displayTag: null, aliases: ["吾悦广场", "新城吾悦"] },
  "joy-city": { name: "大悦城", displayTag: null, aliases: ["大悦城"] },
  "taikoo-li": { name: "太古里", displayTag: null, aliases: ["太古里", "太古地产"] },
  skp: { name: "SKP", displayTag: null, aliases: ["SKP", "北京SKP", "西安SKP"] },
  // ── 权威机构（统计与行业数据的发布方锚）──
  "stats-bureau": { name: "国家统计局", displayTag: null, aliases: ["国家统计局", "统计局"] },
  cntac: { name: "中国纺织工业联合会", displayTag: null, aliases: ["中国纺织工业联合会", "纺织工业联合会", "纺联"] },
  ccfa: { name: "中国连锁经营协会", displayTag: null, aliases: ["中国连锁经营协会", "连锁经营协会"] },
  // ── 电商平台（电商动态归组锚）──
  tmall: { name: "天猫", displayTag: null, aliases: ["天猫", "天猫童装"] },
  "douyin-ecom": { name: "抖音电商", displayTag: null, aliases: ["抖音电商", "抖音商城"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 童装圈同音近形品牌多（巴拉巴拉/巴布豆/贝拉），这条尤其重要。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "balabala", name: "巴拉巴拉", patterns: [/巴拉巴拉|balabala/i] },
  { id: "senma", name: "森马服饰", patterns: [/森马|semir|(?<!\d)002563(?!\d)/] },
  { id: "anta-kids", name: "安踏儿童", patterns: [/安踏儿童|安踏\s?kids|anta\s?kids/i] },
  { id: "anta", name: "安踏体育", patterns: [/安踏体育|安踏集团|\bANTA\b|(?<!\d)02020(?!\d)/] },
  { id: "mini-peace", name: "Mini Peace", patterns: [/mini\s?peace|太平鸟童装/i] },
  { id: "taipingniao", name: "太平鸟", patterns: [/太平鸟|peacebird|(?<!\d)603877(?!\d)/i] },
  { id: "annaier", name: "安奈儿", patterns: [/安奈儿|annil|(?<!\d)002875(?!\d)/i] },
  { id: "qibu", name: "起步股份", patterns: [/起步股份|abc\s?kids|(?<!\d)603557(?!\d)/i] },
  { id: "jinfa-lababi", name: "金发拉比", patterns: [/金发拉比|拉比|labi\s?baby|(?<!\d)002762(?!\d)/i] },
  { id: "yingshi", name: "英氏", patterns: [/英氏|yeehoo/i] },
  { id: "moodytiger", name: "moodytiger", patterns: [/moody\s?tiger/i] },
  { id: "davidbella", name: "戴维贝拉", patterns: [/戴维贝拉|david\s?bella|davidbella/i] },
  { id: "haiziwang", name: "孩子王", patterns: [/孩子王|(?<!\d)301078(?!\d)/] },
  { id: "aiyingshi", name: "爱婴室", patterns: [/爱婴室|(?<!\d)603214(?!\d)/] },
  { id: "biyinlefen", name: "比音勒芬", patterns: [/比音勒芬|biemlfdlkk|(?<!\d)002832(?!\d)/i] },
  { id: "disu", name: "地素时尚", patterns: [/地素|dazzle|(?<!\d)603587(?!\d)/i] },
  { id: "lining", name: "李宁", patterns: [/李宁|li-?ning|(?<!\d)02331(?!\d)/i] },
  { id: "nike", name: "耐克", patterns: [/耐克|\bnike\w*/i] },
  { id: "adidas", name: "阿迪达斯", patterns: [/阿迪达斯|\badidas\b/i] },
  // ── 日报高频主体（ym54 扩容，2026-10-01；判定依据见 agent-hub artifacts/2026-10-01/ym54-identity-lexicon/）──
  { id: "shein", name: "SHEIN希音", patterns: [/希音|shein|(?<!\d)00625(?!\d)/i] },
  { id: "uniqlo", name: "优衣库", patterns: [/优衣库|uniqlo/i] },
  { id: "hm", name: "H&M", patterns: [/h&m/i] },
  { id: "zara", name: "Zara", patterns: [/\bzara\b/i] },
  { id: "primark", name: "Primark", patterns: [/primark/i] },
  { id: "miniso", name: "名创优品", patterns: [/名创优品|miniso/i] },
  { id: "marks-spencer", name: "M&S", patterns: [/\bM&S\b/i, /marks\s*&\s*spencer/i] },
  { id: "babudou", name: "巴布豆", patterns: [/巴布豆/] },
  { id: "in77", name: "湖滨银泰in77", patterns: [/湖滨银泰|in\s?77/i] },
  { id: "hangzhou-tower", name: "杭州大厦", patterns: [/杭州大厦/] },
  { id: "intime", name: "银泰商业", patterns: [/银泰(?!证券|黄金)/] },
  { id: "longfor", name: "龙湖天街", patterns: [/龙湖(天街|商业)|天街/] },
  { id: "mixc", name: "万象城", patterns: [/万象城/] },
  { id: "wanda", name: "万达广场", patterns: [/万达(广场|商业)/] },
  { id: "wuyue", name: "吾悦广场", patterns: [/吾悦(广场)?/] },
  { id: "joy-city", name: "大悦城", patterns: [/大悦城/] },
  { id: "taikoo-li", name: "太古里", patterns: [/太古(里|地产)/] },
  { id: "skp", name: "SKP", patterns: [/\bskp\b/i] },
  { id: "henglong", name: "恒隆", patterns: [/恒隆/] },
  { id: "stats-bureau", name: "国家统计局", patterns: [/国家统计局/] },
  { id: "cntac", name: "中国纺织工业联合会", patterns: [/纺织工业联合会|纺联/] },
  { id: "ccfa", name: "中国连锁经营协会", patterns: [/连锁经营协会/] },
  { id: "tmall", name: "天猫", patterns: [/天猫/] },
  { id: "douyin-ecom", name: "抖音电商", patterns: [/抖音(电商|商城)/] },
  { id: "taobao", name: "淘宝", patterns: [/淘宝/] },
  { id: "jd", name: "京东", patterns: [/京东/] },
  { id: "xiaohongshu", name: "小红书", patterns: [/小红书/] },
];

/** 这些域名上的文章，发布方就是对应的公司（托管平台不算）。只列已确认的品牌官网。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "balabala", domains: ["balabala.com.cn"] },
  { entityId: "senma", domains: ["semir.com"] },
  { entityId: "anta", domains: ["anta.cn", "anta.com"] },
  { entityId: "moodytiger", domains: ["moodytiger.com"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "senma", pattern: /(?:旗下|子公司|集团).{0,6}巴拉巴拉|巴拉巴拉.{0,6}(?:母公司|所属)/ },
];
