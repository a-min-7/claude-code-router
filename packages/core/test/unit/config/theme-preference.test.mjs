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
