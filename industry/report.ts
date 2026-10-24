// 渠道决策晨报的版面与截稿配置（命主 2026-10-01 拍板：定位=渠道决策晨报、截稿 07:00、只放网页）。
// 取数不再看精选：候选=窗口内有新报道的事实，配额控版面长度；精选门槛退回只管单条写作深度。
export const DAILY_REPORT = {
  /** 截稿时刻（北京时间）。D 期覆盖 [D-1 07:00, D 07:00)，schedules 里 07:10 出刊。 */
  deadlineHour: 7,
  /**
   * 候选下限：评分模型均分低于此数不进版面（官方一手不受限）。精选门槛（selection.ts）照旧，
   * 只决定该条用「内容理解」还是便宜摘要的写法，不再当日报门票。
   */
  scoreFloor: 40,
  /**
   * 各分节条数上限。键=taxonomy 里类别的 section 名（2026-10-01 ym40 收拢后的六节）；
   * 没有列到的分节用 defaultSectionQuota，分类再改名也不会空版，届时只需改这里的键名。
   */
  sectionQuotas: { 品牌与竞品: 5, 渠道与商场: 6, 行业与公司: 2, 宏观与数据: 2, 产品与政策: 2, 海外与标杆: 2 } as Record<string, number>,
  defaultSectionQuota: 3,
  /** 简讯栏（版面溢出条）上限。 */
  flashesMax: 6,
} as const;
