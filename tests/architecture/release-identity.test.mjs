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

/** The CLI entry point — the one surface the header above recorded as having NO version. */
const CLI_SOURCE = "packages/cli/src/cli.ts";

test("the CLI answers --version from its manifest, not from a literal", () => {
  const source = readFileSync(path.join(projectRoot, CLI_SOURCE), "utf8");

  // It must READ the manifest, so esbuild inlines the same single-sourced value the resolver
  // gets. A literal here is the drift the header warns about: a version that only some copies
  // carry reads as authoritative.
  assert.match(
    source,
    /import packageJson from "\.\.\/package\.json"/,
    `${CLI_SOURCE} must import its own manifest — the version is single-sourced there, and ` +
      "esbuild inlines it at build time (same mechanism as the resolver's serverInfo.version)"
  );

  // ⚠️ Why this is a SOURCE pin and not a run of the built CLI: the architecture suite runs on
  // a clean checkout, where `packages/cli/dist/main/cli.js` need not exist, so executing it
  // would fail for a reason that has nothing to do with identity. The runtime behaviour —
  // `ccr --version` printing `3.1.0+ccrfork.1`, exit 0 — was verified by hand at the time this
  // was added; what is pinned here is the property that keeps it true.
  assert.match(
    source,
    /command === "version"/,
    `${CLI_SOURCE} must dispatch a \`version\` command — without it \`--version\` falls through ` +
      "to the profile branch and is answered as a PROFILE NAME, which is worse than silence"
  );
  assert.match(
    source,
    /args\[0\] === "--version"/,
    `${CLI_SOURCE} must recognise \`--version\` as a flag in parseArgs`
  );

  // ⚠️ The ordering that made the original bug a bug: the version branch must come BEFORE the
  // profile fallthrough. Measured before the fix, `ccr --version` answered
  // `Profile "--version" was not found or is disabled.` — a wrong answer that looks real.
  const versionIdx = source.indexOf('command === "version"');
  const fallthroughIdx = source.indexOf("const profileOptions = options as ProfileCliOptions");
  assert.ok(
    versionIdx !== -1 && fallthroughIdx !== -1 && versionIdx < fallthroughIdx,
    "the version dispatch must precede the profile fallthrough, or --version is unreachable again"
  );
});

test("the CLI source carries no hardcoded version literal", () => {
  const source = readFileSync(path.join(projectRoot, CLI_SOURCE), "utf8");
  assert.doesNotMatch(
    source.replace(/^\/\/.*$/gm, ""),
    /\d+\.\d+\.\d+\+ccrfork/,
    `${CLI_SOURCE} must not spell the version out — that is a second copy that will drift`
  );
});
