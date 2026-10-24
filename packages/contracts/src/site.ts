export type SourceKind = "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";

// First-party site API (/api/site/*). Not a public API: it may evolve with the website,
// but it is served from the same public read layer as v1, RSS and MCP.
import type { CategoryKey, ChannelKey } from "./taxonomy.ts";
import { isoWeekRange, monthDay } from "./time.ts";
import type { LbProfile } from "./leaderboard.ts";

export interface SourceRef {
  /** The name readers see (publication/rules.ts publicSourceName), as is every source name here. */
  name: string;
  /** Radar read layer (stories/reportView) carries the source identity; optional keeps upstream projections valid. */
  id?: string;
  kind?: string;
  firstParty?: boolean;
  iconUrl?: string | null;
  iconSrcSet?: string | null;
}

export interface MediaView {
  kind: "image" | "video";
  url: string;
  /** Full image for an on-demand viewer; list previews stay small. */
  fullUrl?: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  poster: string | null;
  srcSet?: string;
}

export interface XPostView {
  authorName: string;
  handle: string;
  avatarUrl: string | null;
  avatarSrcSet?: string;
  /** Optional so the site detail's stripped projection (Omit text/translation) stays assignable. */
  text?: string;
  translation?: string | null;
  /** translation: Chinese translation of the quoted post, when it is in another language. */
  quoted: { authorName: string; handle: string; text: string; url: string; translation: string | null } | null;
  media: MediaView[];
}

export interface StoryRef {
  publicId: string;
  title: string;
}

/** What every site answer about an article carries; a card and a page each add the X post in their own form. */
export interface ItemSummary {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  revision?: number;
  source: SourceRef;
  links: { aihot?: string; original: string };
  /** Radar item rail X-post view; absent on upstream projections. */
  x?: XPostView | null;
  publishedAt: string | null;
  discoveredAt: string;
  timelineAt: string;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  story: StoryRef | null;
}

/** The fields rendered by a site feed card; full original text lives in the item detail. */
export interface FeedItemSummary extends Pick<ItemSummary, "id" | "title" | "summary" | "reason" | "source" | "publishedAt" | "timelineAt" | "category" | "tags" | "score" | "selected" | "channel"> {
  x: (Pick<XPostView, "authorName" | "handle" | "avatarUrl" | "avatarSrcSet" | "media"> & {
    quoted: Omit<NonNullable<XPostView["quoted"]>, "url"> | null;
  }) | null;
  /**
   * A selected report whose fact is represented by another report (全部动态 and search): that report,
   * so the card can say "同一件事，精选收录的是《…》" instead of claiming a seat of its own.
   */
  sameEvent?: { id: string; title: string } | null;
}

export interface GroupInfo {
  factId: string;
  /** Radar group card links the fact's story; absent on upstream projections. */
  story: StoryRef | null;
  developmentCount: number;
  /** The newest development when it is not the card's own fact (radar timeline). */
  latestDevelopment?: { factId: string; title: string; at: string } | null;
  /** Other public sources reporting this same news fact, under the current filters. */
  additionalSourceCount: number;
  /** Distinct public reports of this fact. */
  reportCount: number;
  /**
   * The selected reports of this fact under the current filters. The timeline's reader-side unread
   * filter keeps a group while any of them is unread; the timeline fills it, other callers omit it.
   */
  memberIds?: string[];
}

export interface TimelineCard {
  key: string;
  anchorAt: string;
  item: FeedItemSummary;
  group: GroupInfo | null;
}

export interface HotStripEntry {
  rank: number;
  title: string;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  storyPublicId: string | null;
  itemId: string | null;
  participants: HotParticipant[];
  participantCount: number;
}

export interface TimelineFilters {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topic?: string | null;
}

export interface TimelineResponse {
  filters: TimelineFilters;
  cards: TimelineCard[];
  nextCursor: string | null;
  /** Absolute time when a pending item in this scope becomes visible; the page re-checks then. */
  refreshAt?: string | null;
  hot: HotStripEntry[] | null;
  dayCounts: Record<string, number>;
}

export interface PoolResponse {
  generatedAt?: string;
  filters: TimelineFilters & { q: string | null; tab: "time" | "relevance" };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  total: number;
  todayCount: number;
  freshness: string;
}

export interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

/**
 * An article page (/api/site/items/:id) in one language: Chinese (the article itself or its translation)
 * unless …/original asks for the original. Only the body shown is sent, with its outline.
 */
export interface ItemDetail extends ItemSummary {
  readingMode: "full" | "summary-only";
  author: string | null;
  language: string | null;
  /** Chinese body (translation or Chinese original) and original body, whitelisted HTML. */
  body: { zh: string | null; original: string | null; zhKind: "translation" | "original" | null; complete: boolean } | null;
  outline: OutlineEntry[];
  relatedStories: StoryRef[];
  indexable: boolean;
  markdownAvailable: boolean;
  group: GroupInfo | null;
}

export interface SiteItemDetail extends ItemSummary {
  /** The post with all its media; its text is the body. */
  x: Omit<XPostView, "text" | "translation"> | null;
  /** Selected, but its fact's seat is held by this report: marked 同事件, without a reason of its own. */
  sameEvent?: { id: string; title: string } | null;
  readingMode: "full" | "summary-only";
  author: string | null;
  /** Whitelisted HTML of the language shown; the other one is null. */
  body: { zh: string | null; original: string | null; zhKind: "translation" | "original" | null; complete: boolean } | null;
  outline: OutlineEntry[];
  relatedStories: StoryRef[];
  /** The topics the report belongs to. */
  topics?: TopicLink[];
  indexable: boolean;
  markdownAvailable: boolean;
  group: GroupInfo | null;
  hasTranslation: boolean;
  bodyLanguage: "zh" | "original";
  /** 标题命中的品牌档案卡（榜单实体名录 keywords 匹配，最多 3 张）；空数组=无命中。 */
  brands: SiteBrandCard[];
  /** 深解读（ka4）：不点开原文也能懂的一段大白话；null=本文无品牌/商业体/大盘信号，仅保留 AI 导读。 */
  deepRead: SiteDeepRead | null;
}

/** A fact's public reports under the list's filters: what "另外 N 家也报道了" opens. */
export interface GroupReport {
  id: string;
  title: string;
  source: SourceRef;
  timelineAt: string;
  originalUrl: string;
}

export interface GroupReportsResponse {
  factId: string;
  revision?: string;
  reports: GroupReport[];
  nextCursor?: string | null;
}

/** A story's developments page (radar groups read layer). */
export interface DevelopmentsResponse {
  story: StoryRef;
  revision: string;
  developments: Array<{ factId: string; title: string; occurredAt: string | null; reportCount: number; representative: ItemSummary }>;
  nextCursor: string | null;
}

// Hot ranking and stories

/** Home and hot-ranking faces show the same maximum number of editorial participants. */
export const HOT_FACE_LIMIT = 6;

export interface HotParticipant {
  name: string;
  kind: "editorial" | "signal";
  /** Only visible faces carry images: the source's icon or its latest collected X avatar (proxied). */
  iconUrl?: string | null;
  iconSrcSet?: string;
}


export interface HotEntryView {
  rank: number;
  story: StoryRef;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising" | "macro" | "mall" | "brand">;
  participantCount: number;
  sourceCount: number;
  sourceNames: string[];
  participants: HotParticipant[];
  /** Hourly heat over the 24 hours up to the ranking, oldest first; null where no comparable snapshot exists. */
  spark: Array<number | null>;
  /** A card excerpt of the story's AI digest, else its fact statement; full text is on the event page. */
  summary: string | null;
  /** The latest development, one line. */
  latest: string | null;
  /** A picture from the story's public reports (the representative first), for the leading cards. */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null } | null;
}

export interface HotResponse {
  computedAt: string | null;
  ruleVersion?: string | null;
  windowHours: number;
  entries: HotEntryView[];
}

export interface HeatPoint {
  hour: string;
  heat: number;
  participants: number;
}

export interface StoryReportView {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef & { firstParty: boolean };
  publishedAt: string;
  selected: boolean;
  originalUrl?: string;
  factId?: string | null;
}

export interface StoryFactView {
  factId: string;
  title: string;
  firstReportAt: string;
  reportCount: number;
  representative: StoryReportView;
}

export interface StoryDetail {
  publicId: string;
  title: string;
  status: "active" | "watching" | "settled";
  reportCount: number;
  sourceCount: number;
  firstReportAt: string | null;
  latestAt: string | null;
  digest: string | null;
  digestUpdatedAt: string | null;
  /** The story's own factual summary, when it has one. */
  summary: string | null;
  /** Without a digest or summary: the summary of the report the story started from. */
  excerpt: { text: string; sourceName: string } | null;
  latest: string | null;
  /** The current public report supplying latest; never inferred from an independently generated digest. */
  latestReport?: { id: string } | null;
  whyHot: {
    participants48h: number;
    newParticipants6h: number;
    recentReports24h: number;
    observationComplete: boolean;
    rank: number | null;
    heat?: number | null;
  };
  developments: StoryFactView[];
  officialReports: StoryReportView[];
  timeline: StoryReportView[];
  heat: HeatPoint[];
  related: Array<StoryRef & { relation: "storyline" | "related" }>;
  /** The topics its reports belong to, most reports first. */
  topics?: TopicLink[];
}

// Reports (daily / weekly / monthly)

export type ReportKind = "daily" | "weekly" | "monthly";

/** What each kind of report is called. */
export const REPORT_NAMES: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };

/** An issue's date as Chinese readers write and search it: "10月17日", "10月12日—18日" (or "9月28日—10月4日"), "2026年10月". */
export function reportDateLabel(kind: ReportKind, key: string): string {
  if (kind === "daily") return monthDay(key);
  if (kind === "monthly") return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;
  const { start, end } = isoWeekRange(key)!;
  return `${monthDay(start)}—${start.slice(5, 7) === end.slice(5, 7) ? `${Number(end.slice(8, 10))}日` : monthDay(end)}`;
}

export interface ReportCitation {
  itemId: string | null;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceIconUrl: string | null;
  sourceIconSrcSet?: string;
  firstParty: boolean;
  /** When the cited report was published, if it is still in the database. */
  publishedAt: string | null;
  /** False once the item was withdrawn; the citation then shows as removed. */
  available: boolean;
  /** A daily entry: other sources that reported the event by the issue's cutoff. */
  otherSources?: number;
  /** A daily entry's other developments of the event, or reports of the launch merged into it (titles only). */
  related?: ReportCitation[];
  /** A daily entry whose event an earlier daily covered: that issue's date. */
  followUp?: string;
  /** ym132-②：该条目的实体标签（article_entities 标注，同文章页公开闸；≤3 个，品牌→渠道→商场序）。 */
  entities?: Array<{ type: "brand" | "channel" | "mall" | "mall-chain"; slug: string; name: string }>;
}

export interface ReportDetail {
  kind: ReportKind;
  key: string;
  /** The issue's place among the existing issues of its kind, oldest first ("第 N 期"). */
  issueNumber: number;
  title: string;
  generatedAt: string;
  lead: { title: string; leadParagraph: string } | null;
  /** The still-public item the front page leads with (its headline links there). */
  leadItemId: string | null;
  overview: string | null;
  /** Radar og card: the issue's story count (readingMinutes exists further below as required). */
  stories?: Array<{ id: string }>;
  highlights: ReportCitation[];
  /** 主编点评（ym44）：头条条目的「对渠道生意的含义」单句。旧期没有此字段，为空数组。 */
  soWhats: Array<{ itemId: string; soWhat: string }>;
  /** As edited: daily categories, weekly and monthly themes. */
  sections: Array<{ label: string; summary: string | null; items: ReportCitation[] }>;
  flashes: ReportCitation[];
  /**
   * The front page's picture: from the lead item (a daily's lead, a weekly or monthly's first highlight),
   * else from another public report of that event. Captioned with the story when it is not the lead's own.
   */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null; caption: string | null } | null;
  metrics: Record<string, number>;
  readingMinutes: number;
  prev: string | null;
  next: string | null;
}

export interface ReportIndexEntry {
  key: string;
  issueNumber: number;
  title: string | null;
  count: number;
}

export interface ReportIndexResponse {
  kind: ReportKind;
  items: ReportIndexEntry[];
}

/** The latest report page: its archive selector and the report in one request. */
export interface ReportLatestPage {
  index: ReportNavigationEntry[];
  report: ReportDetail | null;
}

/** A report's archive selector, or one month of the daily archive. */
export interface ReportNavigationResponse {
  items: ReportNavigationEntry[];
}

/** Site-wide facts for the web shell: the changelog red-dot anchor. */
export interface SiteMeta {
  changelogVersion: string;
}

/** One entry of the site's changelog (site/changelog.json), newest first. */
export interface ChangelogRelease {
  date: string;
  time: string;
  kind: "更新" | "优化" | "公告" | "下线";
  title: string;
  body: string[];
  /** A notice readers must act on: drawn in the warning red so it cannot be skimmed past. */
  urgent?: true;
  /** A major release's long form, drawn by the site's own drawing when it ships one; its shape is the site's. */
  feature?: unknown;
}

export interface ChangelogResponse {
  latestVersion: string;
  releases: ChangelogRelease[];
}

/**
 * The about page's contact codes (uploaded in the admin or shipped with the site; null when there is
 * none) and the maker's avatar through the image proxy.
 */
export interface SiteContact {
  wechatQr: string | null;
  feishuQr: string | null;
  makerAvatar: string | null;
}

/** Figures and samples for the about page (site-only; not part of v1). */
export interface SiteStats {
  /** Sources collected from now. */
  sources: number;
  /** Enabled sources by kind: x_search, rss, web_list, mp_account, json_list. */
  sourceKinds: Record<string, number>;
  /** Everything collected and not withdrawn, heat-only sources included. */
  items: number;
  selected: number;
  dailies: number;
  /** The last 24 hours: items found (heat-only sources included), and items that made 精选 (by their place on the timeline). */
  day: { collected: number; selected: number };
  /** Enabled sources in a daily shuffle, for the about page's river: one line per source. */
  sampleSources: Array<{ name: string; kind: string; heatOnly: boolean }>;
  /** The latest 精选, newest first. */
  latest: Array<{ id: string; title: string; source: string }>;
}

/** 深解读（ka4）：站内历史+档案支撑的大白话解读，angle 标明依据的是哪类材料；plain=保底直接解读（海外类目/打包稿；2026-10-05 起 10 月后发布的无信号文章也走此兜底，命主规则7=深解读标配）。 */
export interface SiteDeepRead {
  kind: "brand" | "mall" | "mixed" | "macro" | "plain";
  angle: "history" | "analogy" | "direct" | "macro";
  interpretation: string;
  entities: Array<{ type: "brand" | "mall"; name: string }>;
  updatedAt: string;
}

/** 研报观点（ka2）：研报正文里对品牌/商业体/行业的单条研判，figures 保留数值+单位+口径。 */
export interface SiteInsight {
  entityId: string | null;
  entityName: string | null;
  kind: "rating" | "forecast" | "performance" | "expansion" | "product" | "risk" | "industry";
  stance: "positive" | "neutral" | "negative" | null;
  statement: string;
  figures: Array<{ value: string; unit: string; caliber: string }>;
  quote: string | null;
  org: string | null;
  publishedAt: string | null;
  articleUrl: string;
  articleTitle: string;
}

export interface SiteInsightsResponse {
  insights: SiteInsight[];
}

/** 文章详情右侧的品牌简介卡数据：榜单名录实体 + 人工种子档案。 */
export interface SiteBrandCard {
  slug: string;
  name: string;
  provider: string | null;
  profile: LbProfile | null;
}

export interface StoryFollowup {
  factId: string;
  representative: { id: string; title: string; source: { name: string }; timelineAt: string };
}
export interface StoryFollowupsResponse { items: StoryFollowup[]; more: boolean }

/**
 * A starred item as the site can show it now (/api/site/items/availability, keyed by id). Stars keep the
 * source name of the day they were saved; a public item also brings the name shown today.
 */
export interface ItemAvailability {
  status: "public" | "summary-only" | "unavailable";
  sourceName?: string;
}

/** An issue in the archive and the calendar, numbered in its whole series; closed daily months omit their titles. */
export interface ReportNavigationEntry { key: string; issueNumber: number; title?: string | null; count?: number }

// Topics

export type TopicGroupKey = "company" | "field" | "genre";

export interface TopicGroup {
  key: TopicGroupKey;
  name: string;
  blurb: string;
}

export interface TopicLink {
  slug: string;
  name: string;
}

/** A mark drawn beside a name: its logo, or a monogram when there is none. */
export interface Brand {
  /** Site-relative logo path, or null when only a monogram is available. */
  src: string | null;
  monogram: string;
  /** Raster marks get a light backing plate in dark mode. */
  raster: boolean;
}

export interface TopicSummary extends TopicLink {
  group: TopicGroupKey;
  definition: string;
  /** Companies: their logo mark where the site has one, else their initial. */
  brand: Brand | null;
  /** Selected reports, one per fact (as v1 and RSS count the selected set). */
  total: number;
  /** Of those, in the last 30 days. */
  recent: number;
  /** Enough content to be listed and indexed. */
  indexable: boolean;
  /** The newest selected report. */
  latest: { title: string; at: string } | null;
}

export interface TopicsResponse {
  groups: TopicGroup[];
  topics: TopicSummary[];
}

/** Phone search only needs links, not the topic pages or full hot ranking. */
export interface SearchSuggestions {
  topics: Array<TopicLink & { group: TopicGroupKey }>;
  hot: Array<{ rank: number; title: string; to: string }>;
}

export interface TopicPage {
  topic: TopicSummary & { groupName: string; /** Every listed report, selected or not. */ poolTotal: number };
  /** The site's modules' parts of the page, under their names; each module's web part draws its own. */
  modules: Record<string, unknown>;
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  pageSize: number;
}
// ---------------------------------------------------------------------------
// 后台契约（TZR-20261003 T01/ym239 冻结；plan §6/§13/§16）：
// 只服务已鉴权后台（/api/admin/*），由 T20（身份 capability）、T19/T06B（机会与审核）、
// T06（质量/候选接线）消费。公开读取层不得引用本段类型；公开 DTO 不得包含内部入驻资料
// （机械反例见 tests/contract-dto.test.ts）。
// ---------------------------------------------------------------------------

/** 身份能力（T20 消费；服务端权威判定）：缺 grant/未知身份=空数组（fail-closed，不默认升级）。 */
export type AdminCapability = "admin:operate" | "channel:read" | "channel:feedback" | "channel:confirm";
export const ADMIN_CAPABILITIES: readonly AdminCapability[] = ["admin:operate", "channel:read", "channel:feedback", "channel:confirm"];

/** /api/admin/me 视图（T20 在既有 {name,csrf,dev} 上增 capabilities；csrf 仍为会话级原值）。 */
export interface AdminMeView {
  name: string;
  csrf: string;
  dev: boolean;
  /** 服务端判定的能力集；未知 principal 或未授权=空数组（客户端伪造不升级）。 */
  capabilities: AdminCapability[];
}

/** 入驻/机会五状态（plan §13；与 DB store_archive_bridge / opportunity_reviews 的 CHECK 单一词汇）。 */
export type AdminOccupancyState = "confirmed_open" | "historical" | "planned" | "pending_review" | "not_found";
/** 五状态值域单源（ym326 审计 P2-2）：路由层 confirm 校验与 opportunities/read/review 模块
 *  一律导入本常量，不再各自维护词汇副本；tests/contract-dto.test.ts 断言其与 LABELS 键一致。 */
export const ADMIN_OCCUPANCY_STATES: readonly AdminOccupancyState[] = ["confirmed_open", "historical", "planned", "pending_review", "not_found"];
export const ADMIN_OCCUPANCY_STATE_LABELS: Record<AdminOccupancyState, string> = {
  confirmed_open: "当前已确认在营",
  historical: "历史曾入驻",
  planned: "计划开业",
  pending_review: "待核",
  not_found: "未检出档案",
};

/** 证据成色（editing-manual §6 词汇：已核事实/报道/估算/推断/待核线索）。 */
export type AdminEvidenceGrade = "fact" | "report" | "estimate" | "inference" | "lead";

/** 后台机会行的公开事实证据（只允许既有 published 公开事实；私有桥资料不进本结构）。 */
export interface AdminOpportunityEvidence {
  grade: AdminEvidenceGrade;
  sourceName: string;
  url: string;
  at: string | null;
}

export interface AdminOpportunityEvent {
  kind: "opening" | "closing" | "cooperation" | "other";
  at: string | null;
  title: string;
  sourceName: string | null;
}

/** 后台机会行（T19 消费；内部资料，禁止进公开 API/RSS/sitemap/llms/外部模型）。 */
export interface AdminOpportunityRow {
  entity: { type: "brand" | "mall"; slug: string; name: string };
  city: string | null;
  /** 五状态；"未检出档案"≠"未入驻"（plan §13）。 */
  occupancy: AdminOccupancyState;
  events: AdminOpportunityEvent[];
  evidence: AdminOpportunityEvidence[];
  /** 缺项（人话短语；来自人工核验/桥字段缺失，不猜补）。 */
  missing: string[];
  /** 建议下一步核验（线索表述，不是行动指令，不宣称作签约结论）。 */
  nextChecks: string[];
  /** HUB 承接引用（审阅记录回链）。 */
  hubRef: string | null;
}

export interface AdminOpportunitiesResponse {
  rows: AdminOpportunityRow[];
  generatedAt: string;
}

/** 机会审阅记录视图（T19 review.ts；对应 DB opportunity_reviews 行）。 */
export interface AdminOpportunityReview {
  entity: { type: "brand" | "mall"; slug: string };
  state: AdminOccupancyState;
  missing: string[];
  feedback: string | null;
  hubRef: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

/** 后台信源质量与生命周期面（plan §6；T06 接线）：官方覆盖/待核理由/日期完整度/最近有效样本/政策与证据版本。 */
export interface AdminSourceQualityView {
  sourceId: string;
  /** 官方根准入；null=该源未接入候选生命周期。 */
  official: {
    rootUrl: string;
    origins: string[];
    status: "eligible" | "activated" | "parked" | "rejected" | "suspended";
  } | null;
  /** 待核/未达标理由（人话短语，来自 checks 证据）。 */
  pendingReasons: string[];
  /** 日期完整度（实际计数，不估值）。 */
  dateCompleteness: { total: number; dated: number };
  /** 最近有效试抓样本；null=暂无样本（不伪报可靠性）。 */
  latestSample: { at: string; url: string; ok: boolean } | null;
  policyVersion: string | null;
  evidenceVersion: string | null;
}

/** A story's development card (radar timeline/groups read layer). */
export interface Development {
  factId: string;
  title: string;
  occurredAt: string | null;
  representative: ItemSummary;
  reportCount: number;
}
