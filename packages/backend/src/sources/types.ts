import type { MaterialInput } from "../content/materials.ts";

export interface SourceRow {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, any>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  cursor: Record<string, any> | null;
  fail_count: number;
}

/**
 * What a fetcher found on a listing, before identity and timeline rules are applied. Whether the
 * article page is then fetched for a body is decided per source (jobs/content.ts route).
 */
export type Candidate = Omit<MaterialInput, "sourceId" | "via"> & {
  categories?: string[];
};

/**
 * Independent include gate applied before the noise filter: with `any` set, a listing item must
 * carry one of the words in the frozen listing fields (`fields`, title and excerpt by default) to
 * be stored at all. Config of sources; the noise filter and its keepIfMatches exemption are unchanged.
 */
export interface IngestIncludeFilter {
  any: string[];
  fields?: ("title" | "excerpt")[];
}

export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}
