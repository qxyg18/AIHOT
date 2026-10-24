// yn124: prompt versions are content hashes and must not depend on checkout line endings.
// Every include-free prompt must hash exactly its LF-normalized file bytes, so the same
// wording checked out with CRLF or LF yields the same version string. Composite prompts
// ({{> include}}) inherit per-file normalization at the raw() read, so they need no
// separate recompute here.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEol, promptVersion } from "@aihot/backend/editorial/prompts";

const DIR = path.resolve(import.meta.dirname, "../industry/prompts");

function expectedVersion(name: string, text: string): string {
  const hash = createHash("sha256");
  hash.update(`${name}\n${text}\n`);
  return `${name}@${hash.digest("hex").slice(0, 10)}`;
}

test("normalizeEol reduces CRLF and lone CR to LF and changes no other byte", () => {
  assert.equal(normalizeEol("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizeEol("x\ny"), "x\ny");
  assert.equal(normalizeEol(""), "");
  assert.equal(normalizeEol("\uFEFFfirst\r\nsecond"), "\uFEFFfirst\nsecond"); // BOM untouched
  assert.equal(normalizeEol("ok"), "ok");
});

test("promptVersion equals the LF-normalized content hash for every include-free prompt", () => {
  let checked = 0;
  let crlfFiles = 0;
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".md"))) {
    const name = file.slice(0, -".md".length);
    const text = readFileSync(path.join(DIR, file), "utf8");
    if (text.includes("{{>")) continue;
    if (text.includes("\r")) crlfFiles++;
    assert.equal(promptVersion(name), expectedVersion(name, normalizeEol(text)), name);
    checked++;
  }
  assert.ok(checked > 0, "no include-free prompts found — test verifies nothing");
  assert.ok(crlfFiles > 0, "no CRLF prompt on disk — this test can no longer detect EOL coupling");
});
