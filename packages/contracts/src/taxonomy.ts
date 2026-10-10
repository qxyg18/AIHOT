// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS).
import { CATEGORIES } from "@aihot/industry/taxonomy";

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

/** The public API, RSS and MCP use the same categories as the website. */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS;
export type PublicApiCategoryKey = CategoryKey;

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return isCategoryKey(category) ? category : null;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

export const LEADERBOARD_PUBLIC_BOARDS = ["brand", "mall"] as const;
export type LeaderboardBoardKey = (typeof LEADERBOARD_PUBLIC_BOARDS)[number];

export const LEADERBOARD_BOARD_LABELS: Record<LeaderboardBoardKey, string> = {
  brand: "童装品牌榜",
  mall: "商业体榜",
};

/** rd9 子榜：总榜的分层视图身份（URL 段）。品牌按价格带四层，商场按定位三层。 */
export const LEADERBOARD_SUB_BOARD_KEYS = ["brand-mass", "brand-mid", "brand-uppermid", "brand-premium", "mall-premium", "mall-mainstream", "mall-value"] as const;
export type LeaderboardSubBoardKey = (typeof LEADERBOARD_SUB_BOARD_KEYS)[number];

export const LEADERBOARD_SUB_BOARD_PARENT: Record<LeaderboardSubBoardKey, LeaderboardBoardKey> = {
  "brand-mass": "brand",
  "brand-mid": "brand",
  "brand-uppermid": "brand",
  "brand-premium": "brand",
  "mall-premium": "mall",
  "mall-mainstream": "mall",
  "mall-value": "mall",
};

export function isLeaderboardSubBoardKey(value: unknown): value is LeaderboardSubBoardKey {
  return typeof value === "string" && (LEADERBOARD_SUB_BOARD_KEYS as readonly string[]).includes(value);
}

export function leaderboardSubBoardPath(key: LeaderboardSubBoardKey): string {
  return `/leaderboard/sub/${key}`;
}

/** 子榜页路径 → 子榜 key；非子榜路径返回 null（BoardTabs 高亮与路由校验共用）。 */
export function leaderboardSubBoardFromPath(pathname: string): LeaderboardSubBoardKey | null {
  const match = /^\/leaderboard\/sub\/([a-z-]+)$/.exec(pathname);
  return match && isLeaderboardSubBoardKey(match[1]) ? match[1] : null;
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
