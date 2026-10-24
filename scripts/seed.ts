// Seeds a fresh site from the industry pack: the demo sources (industry/sources.json, only the ones not
// there yet, so admin edits are never undone). Topics need no seeding: they are read from industry/topics.json.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { importEntityDirectory } from "@aihot/backend/leaderboard/directory";
import { seedTopics } from "@aihot/backend/publication/topics";
import { FEATURES } from "@aihot/industry/features";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
console.log(`topics: ${await seedTopics()}`);
if (process.argv.includes("--topics-only")) {
  await closeDb();
  process.exit(0);
}
let added = 0;
for (const s of sources) {
  assertSupportedConfig(s.kind, s.config);
  const tier = s.tier ?? "T2";
  // First-party means a T1 source, as the admin sets it.
  const inserted = await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${tier}, ${tier === "T1"}, ${s.owner_entity_id ?? null},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            ${s.enabled ?? true}, now())
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  added += inserted.length;
}
console.log(`sources: ${added} added, ${sources.length - added} already there`);
if (FEATURES.leaderboard) {
  // zw12 两榜实体名录（品牌 19 / 商场 ~112）：中文别名预写各 metric 源，身份解析零漂移。
  // AI 模型名录（lb-models-*.json）随 v15 退役不再导入；种子文件保留作历史参考。
  const entities = await importEntityDirectory();
  console.log(`leaderboard entities: ${entities.models} models, ${entities.aliases} names added`);
}
await closeDb();
