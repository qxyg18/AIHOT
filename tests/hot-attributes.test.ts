// 热点榜预留位评选属性（hot-attributes.ts）的规则测试：用例文本取自线上真实候选池
// （红黑人口库区级批次、赢商城市季报、集团财报与 REIT、开业与周年稿）。
import { geoScopeOf, macroScopeRank, mallKindOf, mallKindRank, MALL_KIND_ORDER } from "@aihot/backend/events/hot-attributes";
import assert from "node:assert/strict";
import { test } from "node:test";

test("geo scope: local district data is 其他, first-tier districts stay 一线城市, national markers win", () => {
  // 命主原案：区级批次不进宏观位（非一线）。
  assert.equal(geoScopeOf("成都郫都区人口与经济数据 成都郫都区2026年初常住人口140.49万人"), "other");
  assert.equal(geoScopeOf("[苏州]吴中区人口数据 吴中区2026年初常住人口142.7万人"), "other");
  // 一线城市的区级数据影响范围仍在一线城市内，按命主原句保留。
  assert.equal(geoScopeOf("深圳福田区2025年末常住人口155.44万 深圳福田区人口数据"), "first_tier");
  // 区级条目里的本地排名句「全国第N」与「第七次全国人口普查」不是全国口径。
  assert.equal(geoScopeOf("上海宝山区人口与出生率数据 在上海人口排名第3、全国第15。2025年GDP…"), "first_tier");
  assert.equal(geoScopeOf("大连金普新区常住人口159.7万 在大连人口排名第2、全国第55。第七次全国人口普查常住人口1545万"), "other");
  assert.equal(geoScopeOf("西安雁塔区2026年初常住人口216.53万 第七次全国人口普查显示0-14岁人口…"), "other");
  // 全国口径。
  assert.equal(geoScopeOf("2026年9月PMI回升至扩张区间 国家统计局解读2026年9月PMI"), "national");
  assert.equal(geoScopeOf("2026中秋消费复盘 全国重点零售和餐饮企业日均销售额增长6.1%"), "national");
  assert.equal(geoScopeOf("8月生鲜乳价格环比上涨 8月全国鲜奶平均零售价每斤5.7元"), "national");
  assert.equal(geoScopeOf("艾媒咨询发布调研报告 数据显示中国体验经济市场规模从2020年的3…"), "national");
  // 海外。
  assert.equal(geoScopeOf("英国零售业有效税率71.5%居各行业之首"), "overseas");
});

test("geo scope rank: 全国优于一线城市，其他与海外不入选", () => {
  assert.ok(macroScopeRank("national")! < macroScopeRank("first_tier")!);
  assert.equal(macroScopeRank("other"), null);
  assert.equal(macroScopeRank("overseas"), null);
});

test("mall kind: system-level actions beat a hotter headline of a lower kind", () => {
  assert.equal(mallKindOf("中海分拆佛山千灯湖环宇城REIT拟深交所上市"), "system");
  assert.equal(mallKindOf("南京首单商业REIT金鹰湖滨天地获上交所受理"), "system");
  assert.equal(mallKindOf("华润万象生活中期业绩：138座购物中心零售额增21.7%"), "system");
  assert.equal(mallKindOf("中海150.19亿元摘得上海真如之心地块"), "system");
  assert.equal(mallKindOf("重百接管新世纪中心英利荟启动不闭店改造"), "system");
  // 「轻资产」是体系转型的实指词：与开业同稿时按优先序归体系档。
  assert.equal(mallKindOf("嘉里建设PRISMA新嘉中心开业并转型轻资产模式"), "system");
  // 标题不含动作词时看摘要兜底（战略合作只写在摘要里）。
  assert.equal(mallKindOf("华润万象生活MIXC AIR落地武汉天河机场T3", "湖北机场集团与华润万象生活签署战略合作框架协议，产品线正式落地"), "system");
});

test("mall kind: headline decides the subject; body facts do not promote it", () => {
  // 回归：改造稿的摘要有销售额，但它不是业绩稿（珠海万达存量改造实判）。
  assert.equal(mallKindOf("珠海万达商管存量改造：株洲神农、佛山长华万达广场焕新", "百日内累计客流超700万人次、销售额突破2亿元"), "upgrade");
  // 回归：回溯稿里的「转型为生活场」是修辞，不升体系档（标题里的「开业十年」也不算开业）。
  assert.equal(mallKindOf("七彩云南·第壹城开业十年打造32万平米城市生活枢纽", "等板块，2024年起品牌战略升级为“壹城PARK”。项目招商…"), "upgrade");
  // 周年稿不算开业。
  assert.equal(mallKindOf("深圳坂田万科广场开业两周年新引40余家品牌", "新引入40余家品牌，出租率约99%"), "upgrade");
  assert.equal(mallKindOf("七彩云南·第壹城开业十年打造32万平米城市生活枢纽", "已从流量场转型为昆明呈贡新区的生活场"), "other");
  // 标题写明客流时按流量档（销售数字在摘要里，不越级改判）。
  assert.equal(mallKindOf("武汉大悦城疯抢节客流31.5万，儿童楼层焕新", "销售额突破3620万元"), "traffic");
});

test("mall kind: opening, traffic, first-store and 其他 as stated", () => {
  assert.equal(mallKindOf("广州白鹅潭万象城9月30日开业"), "opening");
  assert.equal(mallKindOf("深圳湾万象城两大艺术场馆启幕"), "opening");
  assert.equal(mallKindOf("广州聚龙湾太古里一期启幕并公布二期规划"), "opening");
  assert.equal(mallKindOf("2026Q2南京商业客流环比涨5.1%、新开111家首店", "南京二季度客流环比增5.1%"), "traffic");
  assert.equal(mallKindOf("2026上半年长沙引进175家首店，TX长沙年轻力中心34家居首"), "first_store");
  assert.equal(mallKindOf("双11前品牌密集接入AI店小蜜客服"), "other");
  // 标题无档位信号时看摘要兜底：趋势稿的摘要里写了客流，按流量档（判不出主题时不硬升）。
  assert.equal(mallKindOf("商场招商转向内容力，KKV限定店成样本", "深圳宝安大仟里店周末及节假日日均客流过万，升级门店销售…"), "traffic");
  // 全文都判不出档位时落其他。
  assert.equal(mallKindOf("上海购物中心30年消费供给结构进化", "2019年至2026年上海购物中心零售业态门店占比从41.82%降至35.78%"), "other");
});

test("mall kind rank: 体系>业绩>开业>流量>升级>首店>其他", () => {
  const ranks = MALL_KIND_ORDER.map((k) => mallKindRank(k));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(mallKindRank("system") < mallKindRank("performance"));
  assert.ok(mallKindRank("performance") < mallKindRank("opening"));
  assert.ok(mallKindRank("opening") < mallKindRank("traffic"));
  assert.ok(mallKindRank("traffic") < mallKindRank("upgrade"));
  assert.ok(mallKindRank("upgrade") < mallKindRank("first_store"));
  assert.ok(mallKindRank("first_store") < mallKindRank("other"));
});