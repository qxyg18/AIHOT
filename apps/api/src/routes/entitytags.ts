// Entity tag API (zx18): the visible tags per article, and the aggregated entity page
// (profile + leaderboard rank + related articles) the tags link to.
import type { FastifyInstance } from "fastify";
import { articleEntities, entityProfile } from "@aihot/backend/entitytags/read";
import type { EntityType } from "@aihot/backend/entitytags/matcher";
import { siteHandler } from "./site.ts";
import { sendJsonWithEtag, sendProblem } from "../http/respond.ts";

const CACHE = "public, max-age=300, s-maxage=600";
const TYPES: EntityType[] = ["brand", "mall", "mall-chain", "channel"];

export function registerEntityTags(app: FastifyInstance) {
  const guarded = siteHandler;

  app.get("/api/site/articles/:id/entities", guarded(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return sendJsonWithEtag(req, reply, { entities: await articleEntities(id) }, { etagPrefix: `entities-${id}`, cacheControl: CACHE });
  }));

  app.get("/api/site/entity/:type/:slug", guarded(async (req, reply) => {
    const { type, slug } = req.params as { type: string; slug: string };
    if (!TYPES.includes(type as EntityType)) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "not found", cacheControl: "public, max-age=60" });
    }
    const profile = await entityProfile(type as EntityType, slug);
    if (!profile) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, profile, { etagPrefix: `entity-${type}-${slug}`, cacheControl: CACHE });
  }));
}
