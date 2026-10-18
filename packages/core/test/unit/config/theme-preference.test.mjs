import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

// Isolate the config store BEFORE importing anything that resolves it at module
// load. These imports are dynamic for that reason: a static import is hoisted
// and evaluated before any top-level assignment, so it would bind
// ~/.claude-code-router/config.sqlite — the LIVE store.
//
// ⚠️ Measured 2026-10-17: without this block the test rewrote the real
// `app_config.default` row (HOST became "theme-preference-stale-save.test",
// theme "dark"). A test must never write production state.
const root = path.join(os.tmpdir(), `theme-preference-${process.pid}`);
process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "home");
process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(root, "app-data");
process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(root, "user-data");

let configRepo;
let configApi;

before(async () => {
  configRepo = await import("@ccr/core/config/config-repository.ts");
  configApi = await import("@ccr/core/config/config.ts");
});

// ⚠️ THE GUARD, and it runs FIRST because it is the property the two tests below rely on.
// The env block at the top of this file is a SETUP, and a setup regresses silently the
// moment someone hoists an import or moves the assignment below it. This asserts the
// OUTCOME instead: whatever the app resolves as its config directory must sit inside the
// temp root this file owns.
//
// Resolution only — it reads the path and writes nothing — so it is safe under any HOME,
// which is what makes it usable as the RED half of its own control: with the env block
// removed it resolves the live store and fails, without ever touching it.
test("the config store resolves inside this test's own temp dir, never the live one", async () => {
  const { resolveRuntimeConfigDir } = await import("@ccr/core/runtime/app-paths.ts");
  const configDir = path.resolve(resolveRuntimeConfigDir());
  const owned = path.resolve(root) + path.sep;
  assert.ok(
    configDir.startsWith(owned),
    `config dir resolved OUTSIDE this test's temp root — the suite would write production state.\n  resolved: ${configDir}\n  owned   : ${owned}`
  );
});

test("theme preference persistence changes only the theme field", async () => {
  const current = await configApi.loadAppConfig();
  const markerHost = "theme-preference.test";
  await configRepo.replacePersistedAppConfig({
    ...current,
    HOST: markerHost,
    theme: "system"
  });

  const savedTheme = await configApi.saveAppThemePreference("dark");
  const persisted = await configRepo.loadPersistedAppConfig();

  assert.equal(savedTheme, "dark");
  assert.equal(persisted.theme, "dark");
  assert.equal(persisted.HOST, markerHost);
  assert.equal((await configApi.loadAppConfig()).theme, "dark");

  const staleConfig = {
    ...current,
    HOST: "theme-preference-stale-save.test",
    theme: "system"
  };
  const savedConfig = await configApi.saveAppConfig(staleConfig);
  assert.equal(savedConfig.theme, "dark");
  assert.equal(savedConfig.HOST, staleConfig.HOST);
});

test("theme preference persistence rejects unsupported values", async () => {
  await assert.rejects(
    configApi.saveAppThemePreference("sepia"),
    /Invalid theme preference/
  );
});
