// Brand profile read API (zw14): the summaries the article side card and the leaderboard pop-up
// (zw15) render. Reads only ready rows; data refreshes weekly, so a shared cache window is fine.
import type { FastifyInstance } from "fastify";
import { getBrandProfile, listBrandProfiles } from "@aihot/backend/brandprofiles/refresh";
import { siteHandler } from "./site.ts";
import { sendJsonWithEtag, sendProblem } from "../http/respond.ts";

const CACHE = "public, max-age=300, s-maxage=600";

export function registerBrandProfiles(app: FastifyInstance) {
  const guarded = siteHandler;

  app.get("/api/site/brand-profiles", guarded(async (req, reply) => {
    const profiles = await listBrandProfiles();
    return sendJsonWithEtag(req, reply, { profiles }, { etagPrefix: "brand-profiles", cacheControl: CACHE });
  }));

  app.get("/api/site/brand-profiles/:slug", guarded(async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const profile = await getBrandProfile(slug);
    if (!profile) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, profile, { etagPrefix: `brand-profile-${slug}`, cacheControl: CACHE });
  }));
}
