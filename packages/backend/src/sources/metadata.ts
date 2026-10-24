// Metadata backfill for stored articles whose listing carried no date: a bounded scan of the
// original source's detail pages that fills published_at only. Content never changes here (no
// revision, no re-analysis, no full-text fetch); the timeline rule recasts timeline_at/backfill,
// the public projection follows by republishing, and a report that turns historical hands its heat
// evidence back through the existing regroup path (the historical branch decides with no model call).
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { publishArticle } from "../publication/publish.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { fetchDetail } from "./web-list.ts";
import type { SourceRow } from "./types.ts";

/** Persistent progress in sources.cursor.metaEnrich: detail requests that failed (HTTP error or no
 *  usable date) wait out a bounded backoff; a URL that exhausted its attempts stays as a tombstone
 *  so it is never fetched again. A URL whose date was filled leaves the eligible set by itself
 *  (published_at is no longer NULL), so done URLs need no entry here. */
export interface MetaEnrichProgress {
  failed: Record<string, { attempts: number; retryAfter: string }>;
}

export interface MetaEnrichResult {
  /** Dateless articles of this source the window saw (reported to fetch_runs.detail). */
  eligible: number;
  checked: number;
  enriched: number;
  failed: number;
  progress: MetaEnrichProgress;
}

/** Per run: how many dateless articles of one source get one detail request each. */
export const META_ENRICH_PER_RUN = 2;
/** Give up on a URL after this many failed attempts (bounded retries, then a tombstone). */
const MAX_ATTEMPTS = 5;
/** Backoff after the n-th failure: 2h, 4h, 8h…, capped at 7 days. */
const backoffMs = (attempts: number) => Math.min(2 ** attempts * 3600_000, 7 * 86_400_000);
/** A tombstone never comes due: it only keeps the URL out of future windows. */
const NEVER = new Date(8640000000000000).toISOString();

/** One bounded pass over the source's dateless articles (ym253). Pure metadata: the detail request
 *  asks for the date only — no body, no re-extraction — and each filled date is stored through the
 *  normal material entrance, whose metadata path records no revision and starts no analysis. */
export async function enrichMissingMetadata(source: SourceRow, opts: { budget?: number; skipUrls?: Iterable<string> } = {}): Promise<MetaEnrichResult> {
  // The caller (collectSource) only runs this for listing kinds; the guard keeps a future caller
  // from burning detail requests on kinds whose pages have none (x_search).
  if (source.kind === "x_search" || source.kind === "mp_account" || source.kind === "external") {
    return { eligible: 0, checked: 0, enriched: 0, failed: 0, progress: { failed: {} } };
  }
  const budget = opts.budget ?? META_ENRICH_PER_RUN;
  // The listing's own detail path already handled the URLs this run surfaced; those are skipped so a
  // fresh item is never read twice (once by the listing, once by the pass). The pass is for material
  // an earlier run left without a date.
  const skip = [...(opts.skipUrls ?? [])];
  const progress: MetaEnrichProgress = { failed: { ...((source.cursor?.metaEnrich as MetaEnrichProgress | undefined)?.failed ?? {}) } };
  const now = Date.now();
  const waiting = Object.entries(progress.failed).filter(([, f]) => Date.parse(f.retryAfter) > now).map(([url]) => url);
  // Waiting and tombstoned URLs stay out of the window itself, so a run never starves behind a
  // backlog of backed-off entries; eligible reports the real dateless count, not the window size.
  const rows = await sql<{ id: string; url: string; title: string; discovered_at: Date; total: number }[]>`
    SELECT id, url, title, discovered_at, count(*) OVER () AS total FROM articles
    WHERE source_id = ${source.id} AND published_at IS NULL
      ${waiting.length ? sql`AND url NOT IN ${sql(waiting)}` : sql``}
      ${skip.length ? sql`AND url NOT IN ${sql(skip)}` : sql``}
    ORDER BY discovered_at LIMIT ${budget + 100}`;
  const eligible = rows[0]?.total ?? 0;
  let checked = 0;
  let enriched = 0;
  let failed = 0;
  for (const r of rows) {
    if (checked >= budget) break;
    checked += 1;
    try {
      const got = await fetchDetail(r.url, source, { date: true, title: false, summary: false });
      // A date the timeline rule would discard is no date at all: impossible (too far in the future,
      // not finite) or later than the stored discovery (an update stamp, not a publication date). It
      // retries like any other unusable answer, so it cannot loop over every run.
      if (!got.publishedAt || !Number.isFinite(got.publishedAt.getTime()) ||
          got.publishedAt.getTime() > now + 3600_000 || got.publishedAt.getTime() > r.discovered_at.getTime() + 3600_000) {
        throw new Error("no usable date on the detail page");
      }
      const res = await upsertMaterial({
        sourceId: source.id, url: r.url, title: r.title, publishedAt: got.publishedAt,
        discoveredAt: r.discovered_at, via: "fetch",
      });
      delete progress.failed[r.url];
      if (!res.metaDateFilled) continue;
      enriched += 1;
      if (res.metaHistoricalFlip) {
        // The report turned historical: its heat evidence leaves the event graph. The grouping
        // job's regroup_pending branch resets the automatic membership and its historical verdict
        // decides again with no model call; manual memberships are never touched.
        await sql`INSERT INTO regroup_pending (article_id) VALUES (${res.articleId}) ON CONFLICT DO NOTHING`;
        await enqueue(QUEUES.group, { articleId: res.articleId }, { singletonKey: res.articleId });
      } else {
        // The public projection (timeline, search, entity, report candidates) reads the articles
        // row through publishArticle; republishing is idempotent and never re-releases old items.
        await publishArticle(res.articleId);
      }
    } catch {
      failed += 1;
      const attempts = (progress.failed[r.url]?.attempts ?? 0) + 1;
      progress.failed[r.url] = attempts < MAX_ATTEMPTS
        ? { attempts, retryAfter: new Date(now + backoffMs(attempts)).toISOString() }
        : { attempts, retryAfter: NEVER };
    }
  }
  return { eligible, checked, enriched, failed, progress };
}
