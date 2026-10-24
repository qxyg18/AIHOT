// ym82 信息串联: article→profile signal backfill CLI (review channel for the first pass).
//   node scripts/entity-signals.ts extract [--window 14]
//   node scripts/entity-signals.ts list [--status pending|approved|rejected]
//   node scripts/entity-signals.ts approve <id> [--note "..."]   /  reject <id> [--note "..."]
import { closeDb } from "@aihot/backend/db";
import { extractEntitySignals, listEntitySignalDrafts, reviewEntitySignal, SIGNAL_KIND_LABELS } from "@aihot/backend/entitytags/signals";

const args = process.argv.slice(2);
const cmd = args[0] ?? "list";
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd === "extract") {
  const windowDays = Number(flag("--window") ?? 14);
  console.log(JSON.stringify(await extractEntitySignals({ windowDays: Number.isFinite(windowDays) ? windowDays : 14 }), null, 2));
} else if (cmd === "list") {
  const status = flag("--status");
  const rows = await listEntitySignalDrafts(status);
  for (const r of rows) {
    console.log(`${r.status.padEnd(7)} ${r.id}  [${SIGNAL_KIND_LABELS[r.kind] ?? r.kind}] ${r.entityName} ${r.value}${r.unit}${r.caliber ? `（${r.caliber}）` : ""}  《${r.articleTitle ?? r.articleId}》`);
    console.log(`        ${r.quote}`);
  }
  console.log(`${rows.length} draft(s)${status ? ` [${status}]` : ""}`);
} else if (cmd === "approve" || cmd === "reject") {
  const id = args[1] ?? "";
  if (!id) throw new Error("usage: entity-signals.ts approve|reject <id> [--note ...]");
  const result = await reviewEntitySignal(id, cmd, flag("--note") ?? "");
  if (result.duplicateApproved) {
    console.error("提示：同实体同事实已有 approved 行，若为两篇报道同一事实，建议只留其一。");
  }
  console.log(JSON.stringify({ id, ...result }));
} else {
  throw new Error(`unknown command: ${cmd}`);
}
await closeDb();
