// One-off brand mining (zx17): every stored article's title plus the head of its body goes to the
// model in batches; the answers are aggregated into a candidate list (brand, aliases, category,
// parent, mention count, sample titles) for the owner to vet before the seed grows. Read-only on
// articles; the aggregated result is written to the output path given as argv[2].
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { sql, closeDb } from "../packages/backend/src/db.ts";
import { chatJson } from "../packages/backend/src/providers/llm.ts";
import { modelFor } from "../packages/backend/src/editorial/models.ts";
import { promptText, promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { SITE } from "../industry/site.ts";

const BATCH = 30;
const BODY_HEAD = 200;

const Answer = z.object({
  brands: z.array(z.object({
    name: z.string(),
    aliases: z.array(z.string()),
    category: z.enum(["kids-brand", "maternal-brand", "apparel-group", "kids-line"]),
    parent: z.string().nullable(),
    mentions: z.array(z.number().int()),
  })),
});

/** The current directory plus the parent companies, straight from the seed. */
function excludedList(): string[] {
  const seed = JSON.parse(readFileSync("database/seeds/lb-brands-2026-10.json", "utf8")) as {
    brands: Array<{ name: string; provider?: string; keywords?: string[] }>;
  };
  const out = new Set<string>();
  for (const b of seed.brands) {
    out.add(b.name);
    for (const k of b.keywords ?? []) out.add(k);
    if (b.provider) out.add(b.provider);
  }
  return [...out];
}

async function main() {
  const outPath = process.argv[2] ?? "/tmp/brand-mining.json";
  const model = await modelFor("brandProfile");
  const system = promptText("brand-mining", { siteName: SITE.name, excluded: excludedList().join("、") });
  const promptVersionTag = promptVersion("brand-mining");

  const rows = await sql<{ id: string; title: string; excerpt: string | null; body: string | null }[]>`
    SELECT id, title, excerpt, left(coalesce(body_text, ''), ${BODY_HEAD}) AS body FROM articles ORDER BY discovered_at`;
  console.log(`articles: ${rows.length}`);

  const aggregate = new Map<string, { name: string; aliases: Set<string>; category: string; parent: string | null; articles: Set<string>; samples: string[] }>();
  const batches = Math.ceil(rows.length / BATCH);
  for (let i = 0; i < batches; i++) {
    const slice = rows.slice(i * BATCH, (i + 1) * BATCH);
    const numbered = slice.map((r, j) => {
      const text = [r.title, r.excerpt, r.body?.trim()].filter(Boolean).join("｜").slice(0, 320);
      return `${i * BATCH + j + 1}. ${text}`;
    }).join("\n");
    try {
      const res = await chatJson({
        model, purpose: "brand_mining", subject: `batch-${i + 1}`, promptVersion: promptVersionTag,
        system, user: numbered, schema: Answer, temperature: 0, maxTokens: 6000,
      });
      for (const b of res.data.brands) {
        const key = b.name.trim();
        if (!key) continue;
        const norm = key.toLowerCase();
        const hit = aggregate.get(norm) ?? { name: key, aliases: new Set<string>(), category: b.category, parent: b.parent, articles: new Set<string>(), samples: [] };
        for (const a of [key, ...b.aliases]) if (a.trim()) hit.aliases.add(a.trim());
        if (b.parent) hit.parent = hit.parent ?? b.parent;
        for (const m of b.mentions) {
          // The prompt numbers articles 1..N globally across the whole run, not per slice.
          const art = rows[m - 1];
          if (art) { hit.articles.add(art.id); if (hit.samples.length < 3) hit.samples.push(art.title.slice(0, 50)); }
        }
        aggregate.set(norm, hit);
      }
      console.log(`batch ${i + 1}/${batches}: +${res.data.brands.length}`);
    } catch (error) {
      console.log(`batch ${i + 1}/${batches} FAILED: ${String(error).slice(0, 160)}`);
    }
  }

  const out = [...aggregate.values()]
    .map((v) => ({ name: v.name, aliases: [...v.aliases].filter((a) => a !== v.name), category: v.category, parent: v.parent, mentions: v.articles.size, samples: v.samples }))
    .filter((v) => v.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);
  writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");
  console.log(`candidates: ${out.length} -> ${outPath}`);
  await closeDb();
}

await main();
