import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { loadItemRailData } from "../lib/item-rail.server";

export { default, headers, meta } from "./item";

// T14: the original-text page renders ItemPage, so its loader must return the same shape
// (item + insights + entities). Before, it returned only {item} and ItemPage's
// `entities.filter` threw — a hard 500 on every existing legal original.
export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { signal: request.signal });
  return loadItemRailData(item, request.signal);
}
