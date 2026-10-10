// ym118: collector outputs → brand store archive tables (brand_stores / brand_store_counts).
// Reads the Amap expansion line's out/expand files (copied into the container next to this
// script) and upserts. Pure local, re-runnable: the mall signal (name embed + proximity) is
// recomputed on every run, so it improves as the mall dictionary grows without re-crawling.
// Run inside a container: docker exec aihot-api-1 node scripts/sync-brand-stores.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const OUT = path.join(REPO_ROOT, "scripts/collectors/out");
const F_COUNTS = path.join(OUT, "expand/brand-store-counts.json");
const F_STORES = path.join(OUT, "expand/brand-stores.json");
const F_CAND = path.join(OUT, "expand/mall-candidates.json");
const F_GROUP = path.join(OUT, "expand/group-projects.json");
const F_COORDS = path.join(OUT, "mall-coords.json");
const F_SEED_MALLS = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");

const STRONG_M = 150;
const WEAK_M = 400;

type StorePoi = {
  poi_id: string; name: string; type?: string | null; address?: string | null;
  province?: string | null; city?: string | null; district?: string | null;
  lng?: number | null; lat?: number | null; fetchedAt?: string | null;
};

interface MallEntry { ref: string; name: string; city: string | null; lng: number | null; lat: number | null }

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/** Amap returns [] or a one-element array for some fields — coerce to a plain string. */
const asStr = (v: unknown): string => (Array.isArray(v) ? asStr(v[0]) : typeof v === "string" ? v : v == null ? "" : String(v));
/** The collector writes naive Beijing wall-clock strings ("2026-10-02T16:35:45", datetime.now()
 *  with no zone). The container's PG session runs UTC, so a bare string would be read as UTC —
 *  8 hours ahead of the real instant. Pin the zone before it reaches timestamptz. */
const asTs = (v: unknown): string | null => {
  const s = asStr(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) ? `${s}+08:00` : s;
};
/** Same normalisation as the collector（norm_name）：drop punctuation/space, 广场/购物中心. */
const norm = (v: unknown) => asStr(v).replace(/[（）()·—\-\s]/g, "").toUpperCase().replace(/广场/g, "").replace(/购物中心/g, "");
const normCity = (v: unknown) => asStr(v).replace(/市$/, "");
const haversine = (lng1: number, lat1: number, lng2: number, lat2: number) => {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
};

/** The mall dictionary: seed directory + candidate pool + group-project POIs. */
function mallDictionary() {
  const named: Array<MallEntry & { normName: string }> = [];
  const byCity = new Map<string, MallEntry[]>();
  const add = (e: MallEntry) => {
    const n = norm(e.name);
    if (n.length >= 3) named.push({ ...e, normName: n });
    const key = normCity(e.city);
    byCity.set(key, [...(byCity.get(key) ?? []), e]);
  };
  const seeds = readJson<{ malls: Array<{ slug: string; name: string; city?: string; keywords?: string[] }> }>(F_SEED_MALLS, { malls: [] });
  const coords = readJson<Record<string, { name?: string; poi_name?: string; city?: string; lng?: number; lat?: number }>>(F_COORDS, {});
  for (const m of seeds.malls) {
    const c = coords[m.slug];
    add({ ref: m.slug, name: m.name, city: m.city ?? null, lng: c?.lng ?? null, lat: c?.lat ?? null });
    for (const k of m.keywords ?? []) add({ ref: m.slug, name: k, city: m.city ?? null, lng: c?.lng ?? null, lat: c?.lat ?? null });
  }
  for (const [poiId, c] of Object.entries(readJson<Record<string, StorePoi>>(F_CAND, {}))) {
    add({ ref: poiId, name: c.name, city: c.city ?? null, lng: c.lng ?? null, lat: c.lat ?? null });
  }
  const group = readJson<Record<string, { cities: Record<string, { pois: StorePoi[] }> }>>(F_GROUP, {});
  const chains = Object.keys(group);
  for (const g of Object.values(group)) {
    for (const c of Object.values(g.cities ?? {})) {
      for (const p of c.pois ?? []) add({ ref: p.poi_id, name: p.name, city: p.city ?? null, lng: p.lng ?? null, lat: p.lat ?? null });
    }
  }
  return { named, byCity, chains };
}

/** Place one store: name embed (specific mall) → chain hint → coordinate proximity. */
function classify(
  s: StorePoi,
  dict: ReturnType<typeof mallDictionary>,
): { mall_hint: string | null; mall_slug: string | null; mall_match: string | null; distance_m: number | null } {
  const city = normCity(s.city);
  const nameN = norm(s.name ?? "");
  const addrN = norm(s.address ?? "");
  // 1) specific mall named in the store name (longest match wins), same city when the entry has one.
  let best: { ref: string; len: number } | null = null;
  for (const e of dict.named) {
    if (e.city && normCity(e.city) !== city) continue;
    if (nameN.includes(e.normName) && (!best || e.normName.length > best.len)) best = { ref: e.ref, len: e.normName.length };
  }
  if (best) return { mall_hint: null, mall_slug: best.ref, mall_match: "name-embed", distance_m: null };
  // 2) chain-level hint（集团词）in name or address — records which chain, not which project.
  const hintText = `${s.name ?? ""}${s.address ?? ""}`;
  for (const chain of dict.chains) {
    if (hintText.includes(chain)) return { mall_hint: chain, mall_slug: null, mall_match: "chain", distance_m: null };
  }
  // 3) proximity to a known mall POI in the same city.
  if (typeof s.lng === "number" && typeof s.lat === "number") {
    let nearest: { ref: string; d: number } | null = null;
    for (const m of dict.byCity.get(city) ?? []) {
      if (typeof m.lng !== "number" || typeof m.lat !== "number") continue;
      const d = haversine(s.lng, s.lat, m.lng, m.lat);
      if (d <= WEAK_M && (!nearest || d < nearest.d)) nearest = { ref: m.ref, d };
    }
    if (nearest) {
      return { mall_hint: null, mall_slug: nearest.ref, mall_match: nearest.d <= STRONG_M ? "proximity" : "proximity-weak", distance_m: Math.round(nearest.d * 10) / 10 };
    }
  }
  // Also surface an address-embedded mall name when the dictionary knows it in another city form.
  for (const e of dict.named) if (addrN.includes(e.normName)) return { mall_hint: e.name, mall_slug: null, mall_match: "chain", distance_m: null };
  return { mall_hint: null, mall_slug: null, mall_match: null, distance_m: null };
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

const dict = mallDictionary();
const countsFile = readJson<Record<string, { brandName?: string; cities?: Record<string, { count?: number; countCapped?: boolean; pageCapped?: boolean; province?: string | null; sample?: StorePoi[]; fetchedAt?: string }> }>>(F_COUNTS, {});
const storesFile = readJson<Record<string, { brandName?: string; stores?: Record<string, StorePoi> }>>(F_STORES, {});

type Row = {
  brand_slug: string; poi_id: string; name: string; poi_type: string | null; province: string | null;
  city: string | null; district: string | null; address: string | null; lng: number | null; lat: number | null;
  mall_hint: string | null; mall_slug: string | null; mall_match: string | null; distance_m: number | null;
  source: string; fetched_at: string | null;
};

const rows = new Map<string, Row>();   // key brand|poi — full rows overwrite sample rows
const seen = new Map<string, string>(); // key brand|poi -> source
const push = (slug: string, s: StorePoi, source: "sample" | "full") => {
  if (!s?.poi_id) return;
  const key = `${slug}|${s.poi_id}`;
  const prev = seen.get(key);
  if (prev === "full" && source === "sample") return;
  const cls = classify(s, dict);
  rows.set(key, {
    brand_slug: slug, poi_id: asStr(s.poi_id), name: asStr(s.name), poi_type: asStr(s.type) || null,
    province: asStr(s.province) || null, city: asStr(s.city) || null, district: asStr(s.district) || null,
    address: asStr(s.address) || null,
    lng: typeof s.lng === "number" ? s.lng : null, lat: typeof s.lat === "number" ? s.lat : null,
    ...cls, source, fetched_at: asTs(s.fetchedAt),
  });
  seen.set(key, source);
};

let countRows = 0;
for (const [slug, b] of Object.entries(countsFile)) {
  for (const [, cityEntry] of Object.entries(b.cities ?? {})) {
    for (const s of cityEntry.sample ?? []) push(slug, s, "sample");
  }
}
for (const [slug, b] of Object.entries(storesFile)) {
  for (const s of Object.values(b.stores ?? {})) push(slug, s, "full");
}
const all = [...rows.values()];

const countRowsList = Object.entries(countsFile).flatMap(([slug, b]) =>
  Object.entries(b.cities ?? {}).map(([city, e]) => ({
    brand_slug: slug, city, province: e.province ?? null, listed_count: e.count ?? 0,
    count_capped: e.countCapped ?? false, page_capped: e.pageCapped ?? false, fetched_at: asTs(e.fetchedAt),
  })),
);

for (const chunk of chunks(all, 500)) {
  await sql`INSERT INTO brand_stores ${sql(chunk, "brand_slug", "poi_id", "name", "poi_type", "province", "city", "district", "address", "lng", "lat", "mall_hint", "mall_slug", "mall_match", "distance_m", "source", "fetched_at")}
    ON CONFLICT (brand_slug, poi_id) DO UPDATE SET
      name = excluded.name, poi_type = excluded.poi_type, province = excluded.province,
      city = excluded.city, district = excluded.district, address = excluded.address,
      lng = excluded.lng, lat = excluded.lat, mall_hint = excluded.mall_hint,
      mall_slug = excluded.mall_slug, mall_match = excluded.mall_match, distance_m = excluded.distance_m,
      source = excluded.source, fetched_at = excluded.fetched_at, updated_at = now()
    WHERE brand_stores.source <> 'full' OR excluded.source = 'full'`;
}
for (const chunk of chunks(countRowsList, 500)) {
  if (chunk.length === 0) continue;
  await sql`INSERT INTO brand_store_counts ${sql(chunk, "brand_slug", "city", "province", "listed_count", "count_capped", "page_capped", "fetched_at")}
    ON CONFLICT (brand_slug, city) DO UPDATE SET
      province = excluded.province, listed_count = excluded.listed_count,
      count_capped = excluded.count_capped, page_capped = excluded.page_capped,
      fetched_at = excluded.fetched_at, updated_at = now()`;
}
countRows = countRowsList.length;

// Backfill province for count rows collected before the collector wrote it (and for any city
// whose entry carried none): derive the city → province map from the store rows themselves.
// Counts keys use the bare city name ("上海", "湘西"); store rows carry Amap's full name
// ("上海市", "湘西土家族苗族自治州") — match on city-name prefix.
await sql`
  UPDATE brand_store_counts c SET province = m.province, updated_at = now()
  FROM (
    SELECT DISTINCT ON (c2.city) c2.city AS city_key, s.province
    FROM brand_stores s JOIN brand_store_counts c2 ON s.city LIKE c2.city || '%'
    WHERE s.province IS NOT NULL AND s.province <> '' AND char_length(c2.city) >= 2
    ORDER BY c2.city, s.province
  ) m
  WHERE c.city = m.city_key AND (c.province IS NULL OR c.province = '')`;

const byMatch = new Map<string, number>();
for (const r of all) byMatch.set(r.mall_match ?? "none", (byMatch.get(r.mall_match ?? "none") ?? 0) + 1);
const [{ stores: dbStores }] = await sql<{ stores: number }[]>`SELECT count(*)::int AS stores FROM brand_stores`;
const [{ counts: dbCounts }] = await sql<{ counts: number }[]>`SELECT count(*)::int AS counts FROM brand_store_counts`;
const [{ listed }] = await sql<{ listed: number }[]>`SELECT coalesce(sum(listed_count), 0)::int AS listed FROM brand_store_counts`;
console.log(JSON.stringify({
  input_stores: all.length, input_counts: countRows, db_stores: dbStores, db_counts: dbCounts,
  listed_total: listed, mall_match: Object.fromEntries(byMatch),
}, null, 1));
await closeDb();
