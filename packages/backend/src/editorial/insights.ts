// Report insight extraction (ka2): research-category articles get a second pass that pulls the
// report's viewpoints about brands, malls and the industry out of the body — ratings, forecasts,
// performance figures, expansion plans — with the report's own numbers kept as value+unit+caliber
// triples and a source quote. Rows are keyed to the article revision: re-extracting replaces what
// the previous pass wrote, so a backfill can be rerun freely. Consumers: the article page card and
// the leaderboard entity page (read functions below, served by apps/api routes/insights.ts).
import { z } from "zod";
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { ProviderRejectedError, ReceiptUnknownError } from "../providers/receipts.ts";
import { modelFor } from "./models.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { ENTITIES } from "@aihot/industry/taxonomy";
import { SITE } from "@aihot/industry/site";

export const INSIGHT_PROMPT_VERSION = promptVersion("report-insights");

const SYSTEM = promptText("report-insights", {
  siteName: SITE.name,
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});

const Figure = z.object({
  value: z.string(),
  unit: z.string(),
  caliber: z.string(),
});

const Insight = z.object({
  entity_id: z.string().default(""),
  entity_name: z.string().default(""),
  kind: z.enum(["rating", "forecast", "performance", "expansion", "product", "risk", "industry"]),
  stance: z.enum(["positive", "neutral", "negative"]).nullable().catch(null),
  statement: z.string().min(4).max(200),
  figures: z.array(Figure).max(8).default([]),
  quote: z.string().max(300).default(""),
  org: z.string().default(""),
});

const InsightsOut = z.object({ insights: z.array(Insight).max(12) });

/** Body text fed to the model: a report body over ~12k chars is truncated (statement+quote only
 *  need the report's content sections, not its boilerplate tail). */
const BODY_MAX_CHARS = 12_000;

export interface InsightExtractOutcome {
  ok: boolean;
  count: number;
  model: string | null;
  receiptId: number | null;
  error: string | null;
}

/** Extracts insights for one article. The article must be analyzed with relevance=pass; any
 *  category is allowed (the caller decides which categories are worth a pass). */
export async function extractInsights(articleId: string, opts: { attemptTag?: string; db?: Db } = {}): Promise<InsightExtractOutcome> {
  const db = opts.db ?? sql;
  const [row] = await db<{ title: string; body_text: string | null; revision: number }[]>`
    SELECT title, body_text, revision FROM articles WHERE id = ${articleId}`;
  if (!row) return { ok: false, count: 0, model: null, receiptId: null, error: "article missing" };
  const body = (row.body_text ?? "").slice(0, BODY_MAX_CHARS);
  if (body.length < 60) return { ok: false, count: 0, model: null, receiptId: null, error: "body too short" };

  let res: Awaited<ReturnType<typeof callModel>>;
  try {
    res = await callModel(row.title, body, opts.attemptTag);
  } catch (error) {
    if (error instanceof ReceiptUnknownError) {
      return { ok: false, count: 0, model: null, receiptId: error.receiptId, error: `receipt ${error.receiptId} outcome unknown` };
    }
    return { ok: false, count: 0, model: null, receiptId: null, error: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }

  const entities = new Set(Object.keys(ENTITIES));
  const rows = res.data.insights
    .map((i) => {
      const entityId = entities.has(i.entity_id) ? i.entity_id : null;
      const entityName = (i.entity_name || (entityId ? ENTITIES[entityId]!.name : "")).slice(0, 60) || null;
      return {
        entityId,
        entityName,
        kind: i.kind,
        stance: i.stance,
        statement: i.statement.trim().slice(0, 200),
        figures: i.figures,
        quote: i.quote.trim() || null,
        org: i.org.trim().slice(0, 60) || null,
      };
    })
    .filter((i) => i.entityId || (i.entityName && i.entityName !== ""));

  // Replace ALL prior rows for this article (any revision): a re-analysis supersedes the old
  // reading's viewpoints wholesale. The queue's singletonKey serializes extractions per article,
  // so no concurrent writer can interleave between this delete and the inserts below.
  await db`
    DELETE FROM report_insights WHERE article_id = ${articleId}`;
  for (const i of rows) {
    await db`
      INSERT INTO report_insights (article_id, input_revision, entity_id, entity_name, kind, stance, statement, figures, quote, org, model, prompt_version, receipt_id)
      VALUES (${articleId}, ${row.revision}, ${i.entityId}, ${i.entityName}, ${i.kind}, ${i.stance}, ${i.statement},
              ${JSON.stringify(i.figures)}::jsonb, ${i.quote}, ${i.org}, ${res.model}, ${INSIGHT_PROMPT_VERSION}, ${res.receiptId})`;
  }
  return { ok: true, count: rows.length, model: res.model, receiptId: res.receiptId, error: null };
}

async function callModel(title: string, body: string, attemptTag?: string) {
  const model = await modelFor("insight");
  const user = `研报标题：${title}\n\n研报正文：\n${body}`;
  return chatJson({
    model,
    purpose: "report_insights",
    subject: title.slice(0, 60),
    promptVersion: INSIGHT_PROMPT_VERSION,
    system: SYSTEM,
    user,
    schema: InsightsOut,
    temperature: 0.2,
    maxTokens: 4000,
    attemptTag,
  });
}

/** Queue name registered in jobs/queue.ts QUEUES. */
export const INSIGHT_QUEUE = "content.insight";

export async function registerInsightJobs(boss: PgBoss, concurrency = Number(process.env.INSIGHT_CONCURRENCY || 2)) {
  await boss.work<{ articleId: string; attemptTag?: string }>(INSIGHT_QUEUE, { localConcurrency: concurrency, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    const { articleId, attemptTag } = job.data;
    const r = await extractInsights(articleId, { attemptTag });
    if (!r.ok && r.error) {
      // "body too short"/missing article are terminal (no point retrying); anything else — model
      // output failures, provider rejections, unknown receipts — lets pg-boss retry on its schedule.
      const terminal = r.error === "body too short" || r.error === "article missing";
      if (!terminal) throw new Error(r.error);
    }
    return r;
  });
}

// ---- read side (apps/api routes/insights.ts serves these) ----

export interface SiteInsight {
  entityId: string | null;
  entityName: string | null;
  kind: string;
  stance: string | null;
  statement: string;
  figures: Array<{ value: string; unit: string; caliber: string }>;
  quote: string | null;
  org: string | null;
  publishedAt: Date | null;
  articleUrl: string;
  articleTitle: string;
}

type InsightRow = { entity_id: string | null; entity_name: string | null; kind: string; stance: string | null; statement: string; figures: unknown; quote: string | null; org: string | null; published_at: Date | null; url: string; title: string };

const toSite = (r: InsightRow): SiteInsight => ({
  entityId: r.entity_id,
  entityName: r.entity_name,
  kind: r.kind,
  stance: r.stance,
  statement: r.statement,
  figures: Array.isArray(r.figures) ? (r.figures as SiteInsight["figures"]) : [],
  quote: r.quote,
  org: r.org,
  publishedAt: r.published_at,
  articleUrl: r.url,
  articleTitle: r.title,
});

/** Insights of one article, newest first. */
export async function listArticleInsights(articleId: string): Promise<SiteInsight[]> {
  const rows = await sql<InsightRow[]>`
    SELECT i.entity_id, i.entity_name, i.kind, i.stance, i.statement, i.figures, i.quote, i.org, a.published_at, a.url, a.title
    FROM report_insights i JOIN articles a ON a.id = i.article_id
    WHERE i.article_id = ${articleId}
    ORDER BY i.id`;
  return rows.map(toSite);
}

/** Insights about one leaderboard entity (slug = taxonomy ENTITIES key), newest first. */
export async function listEntityInsights(slug: string, limit = 30): Promise<SiteInsight[]> {
  const rows = await sql<InsightRow[]>`
    SELECT i.entity_id, i.entity_name, i.kind, i.stance, i.statement, i.figures, i.quote, i.org, a.published_at, a.url, a.title
    FROM report_insights i JOIN articles a ON a.id = i.article_id
    WHERE i.entity_id = ${slug}
    ORDER BY a.published_at DESC NULLS LAST, i.id DESC
    LIMIT ${limit}`;
  return rows.map(toSite);
}

/** Counts for the admin page: articles with insights vs research articles total. */
export async function insightStats(): Promise<{ articles: number; insights: number }> {
  const [a] = await sql<{ n: number }[]>`SELECT count(DISTINCT article_id)::int AS n FROM report_insights`;
  const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM report_insights`;
  return { articles: a?.n ?? 0, insights: t?.n ?? 0 };
}
