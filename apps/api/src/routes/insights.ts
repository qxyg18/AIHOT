// Report insight read API (ka2): the viewpoints a research article makes about brands/malls/the
// industry, and the viewpoints about one leaderboard entity. Public site data, cached briefly.
import type { FastifyInstance } from "fastify";
import { listArticleInsights, listEntityInsights } from "@aihot/backend/editorial/insights";
import { siteHandler } from "./site.ts";
import { sendJsonWithEtag, sendProblem } from "../http/respond.ts";

const CACHE = "public, max-age=300, s-maxage=600";

export function registerInsights(app: FastifyInstance) {
  const guarded = siteHandler;

  app.get("/api/site/insights/article/:id", guarded(async (req, reply) => {
    const { id } = req.params as { id: string };
    const insights = await listArticleInsights(id);
    return sendJsonWithEtag(req, reply, { insights }, { etagPrefix: "insights-article", cacheControl: CACHE });
  }));

  app.get("/api/site/insights/entity/:slug", guarded(async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const insights = await listEntityInsights(slug);
    return sendJsonWithEtag(req, reply, { insights }, { etagPrefix: `insights-entity-${slug}`, cacheControl: CACHE });
  }));
}
