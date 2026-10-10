// Macro market endpoint (ka7): the /macro page's indicator series. Seeded facts only —
// the page computes display values (YTD, comparisons) from these rows on the fly.
// Data changes only when the seed reruns, so a shared cache window is fine.
import type { FastifyInstance } from "fastify";
import { loadMacroOverview } from "@aihot/backend/macro/read";
// The response shape is the T01/ym239 frozen shared DTO (packages/contracts/src/macro.ts);
// web and API must consume the same contract, not local mirrors.
import type { MacroOverview } from "@aihot/contracts/macro";
import { siteHandler } from "./site.ts";
import { sendJsonWithEtag } from "../http/respond.ts";

export function registerMacro(app: FastifyInstance) {
  app.get("/api/site/macro/overview", siteHandler(async (req, reply) => {
    const body: MacroOverview = await loadMacroOverview();
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "macro-overview", cacheControl: "public, max-age=300, s-maxage=600, stale-while-revalidate=1800" });
  }));
}
