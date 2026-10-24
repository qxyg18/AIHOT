// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { sql } from "../db.ts";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { settleNonEditorial } from "./content.ts";
import { ensureQueue, enqueue, QUEUES } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; signalOnly?: boolean; force?: boolean }>(QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
    if (!job) return;
    try {
      // A discussion post comes here straight from collection: record it first (settleNonEditorial).
      if (job.data.signalOnly && !job.data.force && !(await settleNonEditorial(job.data.articleId)).group) return { verdict: "skipped" };
      const result = await groupArticle(job.data.articleId, { signalOnly: job.data.signalOnly, force: job.data.force });
      if (result.storyId && !result.verdict.startsWith("signal")) {
        await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
      }
      return result;
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError) throw error;
      throw error;
    }
  });
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    return composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection });
  });
}

/** Sweep grouping-pending articles left behind (upstream recover.ts consumes). */
export async function sweepUngrouped(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.grouping_status = 'pending' AND a.created_at < now() - interval '3 minutes'
      AND s.participation_mode = 'editorial' AND a.processing_state = 'analyzed' AND EXISTS (
        SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance = 'pass')
    LIMIT 200`;
  for (const r of rows) await enqueue(QUEUES.group, { articleId: r.id }, { singletonKey: r.id });
  return { enqueued: rows.length };
}
