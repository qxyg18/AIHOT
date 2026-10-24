// Runs the invariant suite with the test database swept before and after (ym86): a crashed or
// failing run must still leave the database clean, since leftover rows age into alerts-suite
// poison. Exits with the suite's own exit code; a failed post-sweep never masks it. Extra args
// are passed through to node instead of the default suite invocation. The module-mock flag is
// part of the default: the ym241 counting guard skips itself without it (ym881).
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const testArgs = args.length ? args : ["--experimental-test-module-mocks", "--test", "--test-concurrency=1", "--test-timeout=120000", "tests/*.test.ts"];

function sweep(phase: string): number {
  const r = spawnSync(process.execPath, ["scripts/test-db-cleanup.ts"], { stdio: ["ignore", "inherit", "pipe"] });
  // A first run against a fresh template database has no tables yet (databases.ts migrates it
  // later, as the runner's global setup): a missing-table pre-sweep is not residue, it is empty.
  const missingTable = r.status !== 0 && /relation ".+" does not exist/.test(String(r.stderr));
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !missingTable) console.error(`[run-invariant-tests] ${phase}-sweep failed (exit ${r.status})`);
  return r.status !== 0 && !missingTable ? (r.status ?? 1) : 0;
}

const pre = sweep("pre");
if (pre !== 0) process.exit(pre);

const run = spawnSync(process.execPath, testArgs, { stdio: "inherit" });
const code = run.status ?? 1;

sweep("post");
process.exit(code);
