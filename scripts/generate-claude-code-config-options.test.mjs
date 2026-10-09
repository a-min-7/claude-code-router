// Tests for the Claude Code config-catalog generator.
//
// The failure this guards against is not a crash: it is a fetch that SUCCEEDS and returns
// markdown the parsers no longer recognise, producing an empty (or truncated) catalog that
// writeJsonIfChanged then persists over the tracked file — one `git add -A` from a public
// fork. See the 2026-10-09 note above catalogGuardViolations in the generator.
//
// Run:  node --test scripts/generate-claude-code-config-options.test.mjs
//
// CCR_GENERATOR_PATH points the behavioural cases at a different revision of the generator,
// which is how the guard is PROVED to fail on pre-change code rather than merely asserted:
//   git show <pre-change-sha>:scripts/generate-claude-code-config-options.mjs > /tmp/old-gen.mjs
//   CCR_GENERATOR_PATH=/tmp/old-gen.mjs node --test scripts/generate-claude-code-config-options.test.mjs
// That run must go RED on "refuses to overwrite a populated catalog".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const realGenerator = path.join(here, "generate-claude-code-config-options.mjs");
const generatorUnderTest = process.env.CCR_GENERATOR_PATH
  ? path.resolve(process.env.CCR_GENERATOR_PATH)
  : realGenerator;

// Always import the REAL module: it is the guarded one, so importing it cannot fire a fetch.
// (The pre-change revision ends in a bare `await main();`, so importing IT would hit the
// network — which is exactly why the behavioural cases below run it as a subprocess.)
const { parseEnvReference, mergeLocalizedEnv, catalogGuardViolations } = await import(
  pathToFileURL(realGenerator).href
);

// The markdown shape the parser is written against: a "## Variables" section whose entries
// are `### \`KEY\`` headings each followed by a prose description.
const wellFormedEnv = [
  "# Environment variables",
  "",
  "## Variables",
  "",
  "### `ANTHROPIC_API_KEY`",
  "",
  "The API key used for Anthropic requests.",
  "",
  "```bash",
  "export ANTHROPIC_API_KEY=sk-ant-xxxxx",
  "```",
  "",
  "### `ANTHROPIC_BASE_URL`",
  "",
  "Overrides the base URL used for API requests.",
  "",
  "```bash",
  "export ANTHROPIC_BASE_URL=https://example.com",
  "```",
  ""
].join("\n");

// Drift A: the docs demote the per-variable heading from `### ` to `## `. This is the form
// measured on 2026-10-09: it takes a real 363-entry list to 0 with no error.
const driftedHeading = wellFormedEnv.replace(/^### /gm, "## ");

test("control: the documented markdown shape parses to a non-empty list", () => {
  // Validates the probe itself. Without a passing control, every negative below is meaningless.
  const parsed = parseEnvReference(wellFormedEnv);
  assert.ok(parsed.length > 0, "control parse produced nothing — the probe is broken, not the code");
  assert.equal(mergeLocalizedEnv(parsed, []).length, parsed.length);
});

test("drift: a heading change zeroes the list and throws nothing", () => {
  // Asserts the FAILURE MODE, so it stays visible if someone later makes the parser strict.
  const parsed = parseEnvReference(driftedHeading);
  assert.equal(parsed.length, 0, "expected the drifted shape to parse to zero");
  assert.equal(mergeLocalizedEnv(parsed, []).length, 0);
});

test("guard: an empty parse over a populated catalog is a violation", () => {
  const previous = { settings: [{ key: "a" }], env: [{ key: "ANTHROPIC_API_KEY" }] };
  const generated = { settings: [], env: [] };
  const violations = catalogGuardViolations(generated, previous);
  assert.equal(violations.length, 2, `expected one violation per section, got: ${violations}`);
});

test("guard: an empty parse with no previous catalog is not a violation", () => {
  // A first-ever run must still fail loudly, but through the fetch/parse path, not this guard —
  // otherwise the guard would block a deliberate regeneration from scratch.
  assert.deepEqual(catalogGuardViolations({ settings: [], env: [] }, undefined), []);
});

test("guard: a healthy parse is not a violation", () => {
  const previous = { settings: [{ key: "a" }], env: [{ key: "X" }] };
  const generated = { settings: [{ key: "a" }, { key: "b" }], env: [{ key: "X" }, { key: "Y" }] };
  assert.deepEqual(catalogGuardViolations(generated, previous), []);
});

// Runs the generator under test as a SUBPROCESS in a throwaway tree, with a stubbed fetch (HTTP
// 200, caller-supplied markdown) and a pre-seeded catalog, then reports what it did.
//
// Subprocess rather than import, so the same cases can be pointed at a pre-change revision via
// CCR_GENERATOR_PATH. That is what makes the regressions below provably RED on old code instead
// of merely asserted — and it is also the only way to run a revision that still ends in a bare
// `await main();`, which would fire a real network fetch if imported.
function runGeneratorInSandbox({ markdown, seedEnv, seedSettings = [] }) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ccr-catalog-guard-"));
  try {
    const scriptsDir = path.join(sandbox, "scripts");
    const catalogDir = path.join(sandbox, "packages", "ui", "src", "generated");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });

    const scriptCopy = path.join(scriptsDir, "generate-claude-code-config-options.mjs");
    copyFileSync(generatorUnderTest, scriptCopy);

    const catalogPath = path.join(catalogDir, "claude-code-config-options.json");
    writeFileSync(catalogPath, JSON.stringify({
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: "test",
      sourceUrls: {},
      settings: seedSettings,
      env: seedEnv
    }, null, 2));

    const stub = path.join(sandbox, "stub-fetch.mjs");
    writeFileSync(stub, `globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => ${JSON.stringify(markdown)} });\n`);

    const run = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, scriptCopy], {
      cwd: sandbox,
      encoding: "utf8"
    });

    return { status: run.status, stderr: run.stderr, catalog: JSON.parse(readFileSync(catalogPath, "utf8")) };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function envTable(separator) {
  return [
    "# Environment variables", "",
    "## Variables", "",
    "| Variable | Purpose |",
    separator,
    "| ANTHROPIC_API_KEY | API key sent as `X-Api-Key`. |",
    "| ANTHROPIC_BASE_URL | Override the API endpoint. |",
    ""
  ].join("\n");
}

test("refuses to overwrite a populated catalog with a drifted parse", () => {
  const { status, stderr, catalog } = runGeneratorInSandbox({
    markdown: driftedHeading,
    seedSettings: [{ key: "s1" }, { key: "s2" }, { key: "s3" }],
    seedEnv: [{ key: "E1" }, { key: "E2" }, { key: "E3" }]
  });

  assert.deepEqual(
    catalog.env.map((entry) => entry.key),
    ["E1", "E2", "E3"],
    "the seeded catalog was overwritten by a drifted parse"
  );
  assert.deepEqual(catalog.settings.map((entry) => entry.key), ["s1", "s2", "s3"]);
  assert.notEqual(status, 0, `expected a non-zero exit; stderr: ${stderr}`);
  assert.match(stderr, /guard tripped/);
});

test("parses a table whose delimiter cells use a single dash", () => {
  // Regression pin for 2026-10-09. The live env-vars page switched its delimiter row from
  // `| --- | --- |` to `| :- | :- |`. GFM needs only one dash per cell; the parser demanded
  // three, so no table matched and env silently went 363 -> 0.
  const { status, stderr, catalog } = runGeneratorInSandbox({
    markdown: envTable("| :- | :- |"),
    seedEnv: [{ key: "E1" }]
  });

  assert.ok(catalog.env.length > 0, `a minimal-dash table parsed to no env entries; stderr: ${stderr}`);
  assert.equal(status, 0, `expected a clean exit; stderr: ${stderr}`);
});

test("still parses the three-dash delimiter style", () => {
  // Control for the case above: it isolates the failure to the delimiter width rather than to
  // "tables are broken", and it must stay green on every revision.
  const { status, catalog } = runGeneratorInSandbox({
    markdown: envTable("| --- | --- |"),
    seedEnv: [{ key: "E1" }]
  });

  assert.ok(catalog.env.length > 0, "a three-dash table parsed to no env entries");
  assert.equal(status, 0);
});

test("the shipped catalog is not degenerate", () => {
  // Cheap canary on the real tracked artifact, so a bad regeneration cannot land unnoticed.
  const catalogPath = path.join(repoRoot, "packages", "ui", "src", "generated", "claude-code-config-options.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  assert.ok(catalog.settings.length > 0, "shipped catalog has no settings");
  assert.ok(catalog.env.length > 0, "shipped catalog has no environment variables");
  assert.equal(catalogGuardViolations(catalog, { settings: [{}], env: [{}] }).length, 0);
});
