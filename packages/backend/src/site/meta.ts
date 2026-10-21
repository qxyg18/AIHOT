// Small site-wide facts for the web shell (e.g. the changelog red-dot anchor).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

export interface ChangelogRelease {
  date: string;
  time: string;
  kind: "更新" | "优化" | "公告" | "下线";
  title: string;
  body: string[];
}

let changelogCache: { mtimeMs: number; data: { latestVersion: string; releases: ChangelogRelease[] } } | null = null;

/** Changelog is published as a data file in the industry pack (industry/changelog.json), newest first.
 *  The file may also live outside the image (AIHOT_CHANGELOG_FILE + a host bind) so a deploy can add
 *  release entries without a rebuild; reload whenever the file's mtime moves, so an edit shows up on
 *  the next request instead of after an api restart. */
export function loadChangelog() {
  const file = process.env.AIHOT_CHANGELOG_FILE || path.join(REPO_ROOT, "industry/changelog.json");
  const mtimeMs = statSync(file).mtimeMs;
  if (!changelogCache || changelogCache.mtimeMs !== mtimeMs) {
    const data = JSON.parse(readFileSync(file, "utf8")) as { latestVersion: string; releases: ChangelogRelease[] };
    changelogCache = { mtimeMs, data };
  }
  return changelogCache.data;
}

export function siteMeta() {
  return { changelogVersion: loadChangelog().latestVersion };
}
