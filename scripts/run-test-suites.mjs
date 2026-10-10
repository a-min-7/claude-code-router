// Run every test suite, always, and report one aggregate result.
//
// WHY THIS EXISTS (2026-10-10)
//   The root `test` script used to be a `&&` chain:
//     npm run test:packages && npm run test:architecture && npm run test:generator
//   `&&` stops at the first failure, so one suite failing silently prevented the rest
//   from running AT ALL. Measured: `test:packages` failed on seven pre-existing core
//   failures and neither `test:architecture` nor `test:generator` executed — so a red
//   `npm test` reported nothing about coverage, and the newest suite (added last, so
//   first skipped) was the least likely ever to run. A suite that never runs cannot go
//   red, which is the failure mode this repo keeps paying for.
//
//   The `&&` chains INSIDE a suite are left alone: they join two phases of one job
//   (bundle the tests, then run them), where stopping on failure is correct. Only the
//   root chain — which joined three INDEPENDENT suites — is replaced.
//
// TEST_SUITES overrides the list, so the failure path can be exercised hermetically
// without running the real suite (same idea as REPO_FF_SYNC_REPOS in repo-ff-sync.sh).
import { spawnSync } from "node:child_process";

const SUITES = (process.env.TEST_SUITES ?? "test:packages,test:architecture,test:generator")
  .split(",")
  .map((suite) => suite.trim())
  .filter(Boolean);

const results = [];
for (const suite of SUITES) {
  process.stdout.write(`\n=== ${suite} ===\n`);
  const { status, error } = spawnSync("npm", ["run", suite], { stdio: "inherit" });
  // A suite that could not even be spawned is a FAILURE, never a silent skip.
  results.push({ suite, status: error ? 127 : (status ?? 1) });
}

const failed = results.filter((result) => result.status !== 0);
console.log("\n=== suite summary ===");
for (const { suite, status } of results) {
  console.log(`  ${status === 0 ? "PASS" : "FAIL"}  ${suite}${status === 0 ? "" : `  (exit ${status})`}`);
}
console.log(`  ${results.length - failed.length}/${results.length} suites passed`);

process.exit(failed.length > 0 ? 1 : 0);
