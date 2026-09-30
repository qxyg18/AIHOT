// One leaderboard computation round (weighted v1, zw12 改造): build the two boards' inputs from the
// latest snapshots, compute weighted scores, publish only when the evidence changed. A failed round
// keeps the previous published run on the site. The v15 Kemeny chain (v15.ts/inputs.ts/kemeny.ts/
// compute-worker.ts) stays in the tree unreferenced for rollback and history.
import { newArticleId, sha256, stableJson } from "../../lib/ids.ts";
import { sql } from "../../db.ts";
import {
  BOARDS,
  METHOD_VERSION,
  TIE_POLICY,
  buildWeightedInputs,
  computeBoards,
  inputFingerprint,
  type WeightedInputs,
} from "./weighted.ts";

export interface RoundResult {
  status: "published" | "unchanged" | "failed";
  runId: string | null;
  fingerprint: string;
  boards: Array<{ board: string; models: number; mode: string }>;
  reason?: string;
}

/** Everything that can change a ranking, and nothing that cannot (fetch times, verification stamps). */
export function fingerprintOf(inputs: WeightedInputs): string {
  return inputFingerprint(inputs);
}

export async function lastCheck(): Promise<{ at: string; fingerprint: string } | null> {
  const [row] = await sql<{ value: { at: string; fingerprint: string } }[]>`SELECT value FROM settings WHERE key = 'leaderboard.last_check'`;
  return row?.value ?? null;
}

async function recordCheck(fingerprint: string, at: Date) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('leaderboard.last_check', ${sql.json({ at: at.toISOString(), fingerprint })}, 'worker')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export async function runLeaderboardRound(opts: { at?: Date; force?: boolean } = {}): Promise<RoundResult> {
  const at = opts.at ?? new Date();
  const inputs = await buildWeightedInputs({ at });
  const fingerprint = inputFingerprint(inputs);
  const [latest] = await sql<{ id: string; fingerprint: string | null }[]>`
    SELECT id, summary->'consensus'->>'fingerprint' AS fingerprint FROM lb_runs
    WHERE status = 'published' ORDER BY generated_at DESC LIMIT 1`;
  if (!opts.force && latest?.fingerprint === fingerprint) {
    await recordCheck(fingerprint, at);
    return { status: "unchanged", runId: latest.id, fingerprint, boards: [] };
  }

  const outputs = computeBoards(inputs);
  // 商场榜冷启动降级（客流单源直榜）不阻断发布；两榜全空才算失败。
  const publishable = outputs.filter((o) => o.entries.length > 0);
  const reason = publishable.length ? undefined : "no board has entries";

  const runId = newArticleId();
  const sourceRows = inputs.boards.flatMap((b) =>
    Object.entries(b.registry).map(([unit, r]) => ({ key: unit, weight: r.weight, familyKey: r.family, board: b.board, operator: r.operator })),
  );
  const summary = {
    boards: BOARDS.map((b) => ({ key: b.key, name: b.name, dimensions: b.dimensions.map(({ key, name, weight }) => ({ key, name, weight })) })),
    sources: sourceRows,
    consensus: {
      input: inputs.boards,
      boards: outputs,
      version: METHOD_VERSION,
      evidence: inputs.evidence,
      tiePolicy: TIE_POLICY,
      fingerprint,
      calculatedAt: new Date().toISOString(),
    },
  };
  const status = reason ? "failed" : "published";
  await sql.begin(async (tx) => {
    await tx`INSERT INTO lb_runs (id, methodology_version, generated_at, source_snapshot_ids, summary, status, origin)
             VALUES (${runId}, ${METHOD_VERSION}, ${at}, ${inputs.snapshotIds}, ${tx.json(summary as never)}, ${status}, 'computed')`;
    if (status !== "published") return;
    const ids = new Map((await tx<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models WHERE slug = ANY(${outputs.flatMap((o) => o.entries.map((e) => e.slug))})`).map((r) => [r.slug, r.id]));
    for (const out of outputs) {
      const dimNames = new Map((BOARDS.find((b) => b.key === out.board)?.dimensions ?? []).map((d) => [d.key, d.name]));
      const rows = out.entries
        .filter((e) => ids.has(e.slug))
        .map((e) => ({
          run_id: runId,
          board: out.board,
          model_id: ids.get(e.slug)!,
          rank: e.rank,
          score: e.score,
          coverage: e.coverage,
          metric_count: e.sourceCount,
          summary: `${e.sourceCount} 项指标 · ${e.operatorCount} 家来源`,
          component_scores: { dimensions: e.dimensions, mode: out.mode },
          detail: { mode: out.mode, sampleInsufficient: e.sampleInsufficient, operatorCount: e.operatorCount, dimensionNames: dimNames },
        }));
      for (let i = 0; i < rows.length; i += 500) await tx`INSERT INTO lb_rankings ${tx(rows.slice(i, i + 500) as never)}`;
    }
  });
  await recordCheck(fingerprint, at);
  return { status, runId, fingerprint, boards: outputs.map((o) => ({ board: o.board, models: o.entries.length, mode: o.mode })), reason };
}
