// 热点榜预留位的评选属性（命主 2026-10-01 定）：
//   宏观位——只取「全国」或「一线城市」影响范围的条目，全国优先一线城市；
//   商业体位——按消息类型优先序评选：商业体系重大消息 > 项目业绩大爆 > 新项目开业 >
//   项目流量高 > 项目升级 > 项目首店 > 其他。
// 属性从条目的公开文本（事件标题 + 代表稿中文标题/摘要）确定性推导，不调模型、不产生增量成本；
// 判不出来一律落最低档（宏观=不入选，商业体=其他），宁缺毋滥，不硬凑。
// 关键词表按线上真实候选池逐条校准（红黑人口库区级批次、赢商城市季报、集团财报与 REIT 等），
// 校准实据：artifacts/2026-10-01/hot-scope-mall-priority-closeout.md。

/** 条目的影响范围。 */
export type GeoScope = "overseas" | "national" | "first_tier" | "other";

/** 商业体消息类型（优先序见 MALL_KIND_RANK）。 */
export type MallKind = "system" | "performance" | "opening" | "traffic" | "upgrade" | "first_store" | "other";

/** 宏观位只收这两个范围，并按此排序：全国优先于一线城市。 */
export const MACRO_SCOPE_ORDER: GeoScope[] = ["national", "first_tier"];

/** 商业体位的评选优先序（越小越优先），落榜档=其他。 */
export const MALL_KIND_ORDER: MallKind[] = ["system", "performance", "opening", "traffic", "upgrade", "first_store", "other"];

const GEO_SCOPE_RANK = new Map(MACRO_SCOPE_ORDER.map((s, i) => [s, i]));
const MALL_KIND_RANK = new Map(MALL_KIND_ORDER.map((k, i) => [k, i]));

/** 宏观位入选名次；不属于全国/一线城市范围时返回 null（不入选）。 */
export function macroScopeRank(scope: GeoScope): number | null {
  return GEO_SCOPE_RANK.get(scope) ?? null;
}

/** 商业体位评选名次（其他=最后一档）。 */
export function mallKindRank(kind: MallKind): number {
  return MALL_KIND_RANK.get(kind) ?? MALL_KIND_ORDER.length - 1;
}

// 海外主体：其主场不在中国大陆，不属于「全国/一线城市影响范围」，不进宏观位。
// 只列国家/地区词，不用「国际」（国内政策词「国际消费中心城市」会被误伤）。
const OVERSEAS = /英国|美国|日本|韩国|德国|法国|意大利|西班牙|荷兰|瑞典|瑞士|加拿大|澳大利亚|新西兰|新加坡|泰国|越南|印度|巴西|墨西哥|俄罗斯|土耳其|欧洲|欧盟|北美|海外|境外|东南亚/;
// 全国口径：官方统计口径词，或指向全国市场/全国规模的表述。
// 两处排除取自线上区级人口批次的真实噪声：「全国第15/排名第24/排第53」是区级条目里的本地排名句，
// 「第七次全国人口普查」是区级条目的引用句，都不是全国口径。
const NATIONAL = /国家统计局|我国|全国(?!人口普查)(?!排?名?居?[\u4e00-\u9fa5]{0,3}第\d)|中国(?=[\u4e00-\u9fa5]{0,4}(市场|消费|经济|行业|制造业|零售|规模|企业|品牌|童装|人口|产业|服装))/;
// 一线城市：北京/上海/广州/深圳（含其下辖区县——区级数据的影响范围仍在一线城市内，按命主原句保留）。
const FIRST_TIER = /北京|上海|广州|深圳/;

/** 判定条目的影响范围。 */
export function geoScopeOf(text: string): GeoScope {
  if (OVERSEAS.test(text)) return "overseas";
  if (NATIONAL.test(text)) return "national";
  if (FIRST_TIER.test(text)) return "first_tier";
  return "other";
}

// 商业体系重大消息：体系/集团级的资本动作、财报、战略与合作。只认动作词与财务名词，
// 不认机构名裸词——「置业/集团」常作为开发商名出现在项目稿的摘要里（如「长沙城发恒伟置业投资建设」），
// 裸词会把开业稿、改造稿误升进第一档；也不认「转型」——回溯稿里「从流量场转型为生活场」是修辞，
// 体系转型写「轻资产」这类实指词（嘉里建设转型轻资产模式）。
const MALL_SYSTEM = /REIT|不动产投资信托|证券投资基金|分拆|收购|并购|私有化|退市|上市|IPO|募集|摘得|竞得|拿地|地块|楼面价|战略合作|战略协议|框架协议|签署|签约|联手|接管|托管|管理输出|轻资产|财报|中期业绩|年度业绩|业绩报告|净利润|营业收入|(集团|商管|置业|控股|地产|生活|建设).{0,12}(业绩|收入|净利|溢利|财报)/;
// 项目业绩大爆：项目/活动的销售与经营结果（主题词判定，不区分涨跌）。
const MALL_PERFORMANCE = /销售额|零售额|营业额|营收|业绩|出租率|销售突破|双位数增长/;
// 新项目开业：场馆实际开门（含窄口径的「新开商场/天街」计划）。周年/回顾稿不算开业。
const MALL_OPENING = /开业|启幕|亮相|试营业|开街|开张|开门迎客|正式运营|新开.{0,6}(商场|购物中心|mall|天街|广场|商业体|商业项目)/;
const OPENING_NOT_ANNIVERSARY = /周年|开业.{0,3}[0-9一二三四五六七八九十]+年/;
// 项目流量高。
const MALL_TRAFFIC = /客流|访客|人气|到场|人次/;
// 项目升级。
const MALL_UPGRADE = /改造|升级|焕新|调改|提档|扩建|扩容|新引|品牌调整|业态调整/;
// 项目首店。
const MALL_FIRST_STORE = /首店|首进|首家|新店型/;

/** 判定商业体消息类型，按优先序取第一个命中的档。 */
function classifyMall(text: string): MallKind {
  if (MALL_SYSTEM.test(text)) return "system";
  if (MALL_PERFORMANCE.test(text)) return "performance";
  if (MALL_OPENING.test(text) && !OPENING_NOT_ANNIVERSARY.test(text)) return "opening";
  if (MALL_TRAFFIC.test(text)) return "traffic";
  if (MALL_UPGRADE.test(text)) return "upgrade";
  if (MALL_FIRST_STORE.test(text)) return "first_store";
  return "other";
}

/**
 * 判定商业体消息类型：标题（事件标题+代表稿中文标题）优先，未命中再看摘要兜底。
 * 标题写明的是这条消息的主题；摘要常夹带次要事实（改造稿里写销售额、开业稿里写开发商名），
 * 直接全文本判定会把主题误升到更高档（实测：珠海万达「存量改造」被摘要里的销售额升为业绩档）。
 */
export function mallKindOf(headline: string, detail = ""): MallKind {
  const head = classifyMall(headline);
  if (head !== "other" || !detail) return head;
  return classifyMall(`${headline} ${detail}`);
}