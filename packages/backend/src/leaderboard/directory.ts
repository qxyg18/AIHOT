// The model directory (database/seeds/lb-models-*.json): display names, providers and release dates,
// and the name each evaluation source uses for a model. A new site imports it before the first round,
// so fetched rows resolve to the same models, names and brand marks as on AIHOT instead of one new
// model per unfamiliar name. Models and aliases already present are kept.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

export const DIRECTORY_FILE = path.join(REPO_ROOT, "database/seeds/lb-models-2026-09-29.json");
export const BRANDS_FILE = path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json");
export const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");
/** v4.5：高德 POI 入驻图谱试点快照（scripts/collectors 产物并入种子目录随镜像分发；缺文件=详情页区块静默关闭）。 */
export const TENANCY_FILE = path.join(REPO_ROOT, "database/seeds/lb-tenancy-2026-10.json");

interface Directory {
  /** [slug, name, provider, provider slug, release date] */
  models: Array<[string, string, string | null, string | null, string | null]>;
  /** source key → the source's name for a model → model slug */
  aliases: Record<string, Record<string, string>>;
}

interface EntityDirectory {
  board: "brand" | "mall";
  directorySource: string;
  brands?: Array<{ slug: string; name: string; provider: string }>;
  malls?: Array<{ slug: string; name: string; city: string }>;
  /** 每个实体名需要预写别名的 metric 源（读取器 source_key）。 */
  aliases: Record<string, Record<string, string>>;
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** 品牌榜/商场榜实体名录导入：lb_models 按 metadata_source 分池，中文名预写各 metric 源别名。 */
export async function importEntityDirectory(files: string[] = [BRANDS_FILE, MALLS_FILE]): Promise<{ models: number; aliases: number }> {
  let models = 0;
  const aliasBuffer: Array<{ id: string; source_key: string; alias: string; normalized_alias: string; model_id: string }> = [];
  const ids = new Map((await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models`).map((m) => [m.slug, m.id]));
  for (const file of files) {
    const dir = JSON.parse(readFileSync(file, "utf8")) as EntityDirectory;
    const entities = (dir.brands ?? dir.malls ?? []).map((e) => ({ slug: e.slug, name: e.name, provider: "provider" in e ? e.provider : ("city" in e ? e.city : "其他") }));
    const rows = entities
      .filter((e) => !ids.has(e.slug))
      .map((e) => ({ id: createId(), slug: e.slug, name: e.name, provider: e.provider, provider_slug: "other", released_at: null, release_date_source: null, metadata_source: dir.directorySource }));
    for (const chunk of chunks(rows, 500)) {
      const res = await sql`INSERT INTO lb_models ${sql(chunk, "id", "slug", "name", "provider", "provider_slug", "released_at", "release_date_source", "metadata_source")}
                            ON CONFLICT (slug) DO NOTHING`;
      models += res.count;
    }
    for (const e of entities) {
      const id = ids.get(e.slug) ?? rows.find((r) => r.slug === e.slug)?.id;
      if (!id) continue;
      ids.set(e.slug, id);
      for (const sourceKey of Object.keys(dir.aliases)) aliasBuffer.push({ id: createId(), source_key: sourceKey, alias: e.name, normalized_alias: e.slug, model_id: id });
    }
  }
  let aliases = 0;
  for (const chunk of chunks(aliasBuffer, 1000)) {
    const res = await sql`INSERT INTO lb_aliases ${sql(chunk, "id", "source_key", "alias", "normalized_alias", "model_id")}
                          ON CONFLICT (source_key, alias) DO NOTHING`;
    aliases += res.count;
  }
  return { models, aliases };
}

export async function importModelDirectory(file = DIRECTORY_FILE): Promise<{ models: number; aliases: number }> {
  const dir = JSON.parse(readFileSync(file, "utf8")) as Directory;
  let models = 0;
  for (const chunk of chunks(dir.models, 500)) {
    const rows = chunk.map(([slug, name, provider, providerSlug, releasedOn]) => ({
      id: createId(), slug, name, provider, provider_slug: providerSlug, released_at: releasedOn,
      release_date_source: releasedOn ? "directory" : null, metadata_source: "directory",
    }));
    const res = await sql`INSERT INTO lb_models ${sql(rows, "id", "slug", "name", "provider", "provider_slug", "released_at", "release_date_source", "metadata_source")}
                          ON CONFLICT (slug) DO NOTHING`;
    models += res.count;
  }
  const ids = new Map((await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models`).map((m) => [m.slug, m.id]));
  const aliasRows = Object.entries(dir.aliases).flatMap(([sourceKey, names]) =>
    Object.entries(names)
      .filter(([, slug]) => ids.has(slug))
      .map(([alias, slug]) => ({ id: createId(), source_key: sourceKey, alias, normalized_alias: slug, model_id: ids.get(slug)! })));
  let aliases = 0;
  for (const chunk of chunks(aliasRows, 1000)) {
    const res = await sql`INSERT INTO lb_aliases ${sql(chunk, "id", "source_key", "alias", "normalized_alias", "model_id")}
                          ON CONFLICT (source_key, alias) DO NOTHING`;
    aliases += res.count;
  }
  return { models, aliases };
}
