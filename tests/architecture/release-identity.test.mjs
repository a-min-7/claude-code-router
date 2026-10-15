/**
 * The fork's identity must be single-sourced, and it must be the FORK's.
 *
 * ⚠️ Why this exists (measured 2026-10-15). This is a FORK, and it advertised no fork
 * identity on any surface: `ccr` has no `--version` at all, and the resolver answered
 * `initialize` with `serverInfo.version = "1.0.0"` — a hardcoded literal. Five manifests
 * carried upstream's plain `3.1.0`, while its own name (`@musistudio/claude-code-router`)
 * and version are upstream's, so nothing distinguished a fork build from upstream's.
 * The identity lived only in `deployed-v<version>-<date>` git tags, which no running
 * process can be asked for.
 *
 * The convention, taken from `mempalace-pi-sweeper` (`version = "3.11.0+pifork.1"`): keep
 * upstream's version, append a local label naming the fork. `+` build metadata is legal
 * semver and is IGNORED by precedence comparison, so it cannot disturb a version check —
 * verified: no semver comparison of this field exists anywhere in the repo, it is only
 * reported.
 *
 * ⚠️ The manifests are the duplication hazard, and the reason this is a test rather than a
 * comment. The version lives in FIVE of them, and `mempalace` already paid for that shape:
 * the version lived in both `pyproject.toml` and `__init__.py` with nothing tying them
 * together, so cutting 0.2.0 while bumping one produced a server reporting `0.1.4` from a
 * `0.2.0` tree (memory/lesson_release_version_duplicated_pyproject_and_init.md). A version
 * that only some copies carry is worse than no version: it reads as authoritative.
 *
 * The wire side of the same rule is pinned in the source: `toolhub-mcp.ts` reads
 * `packageJson.version` rather than a literal, so it cannot drift from this file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

/** Every manifest that moves with a release of this monorepo. */
const RELEASE_MANIFESTS = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/electron/package.json",
  "packages/ui/package.json"
];

/** `docs/` and `cdn/` sit at their own 0.1.0 and are not part of a release. */
const NON_RELEASE_MANIFESTS = ["docs/package.json", "cdn/package.json"];

function readVersion(manifestPath) {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, manifestPath), "utf8"));
  return manifest.version;
}

test("every release manifest carries the SAME version", () => {
  const versions = RELEASE_MANIFESTS.map((manifestPath) => [manifestPath, readVersion(manifestPath)]);
  const distinct = [...new Set(versions.map(([, version]) => version))];

  assert.equal(
    distinct.length,
    1,
    `release manifests disagree — bump them together, never one at a time:\n${versions
      .map(([manifestPath, version]) => `  ${version}  ${manifestPath}`)
      .join("\n")}`
  );
});

test("that version names the fork, not just the upstream base it inherits", () => {
  const version = readVersion("package.json");

  // Upstream's base version must survive — the fork tracks it, and the deploy tags
  // (`deployed-v<version>-<date>`) are keyed on it.
  assert.match(
    version,
    /^\d+\.\d+\.\d+/,
    `the base must remain upstream's semver version, got "${version}"`
  );
  assert.match(
    version,
    /\+ccrfork\.\d+$/,
    `the fork label is missing: "${version}" must be <upstream-version>+ccrfork.<n>. ` +
      "Without it nothing on the wire can tell a fork build from upstream's."
  );
});

test("manifests outside the release are left alone", () => {
  for (const manifestPath of NON_RELEASE_MANIFESTS) {
    assert.doesNotMatch(
      readVersion(manifestPath),
      /ccrfork/,
      `${manifestPath} is not part of a release and must not carry the fork label`
    );
  }
});
