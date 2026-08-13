import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePiGatewayConfig } from "@ccr/core/agents/pi/profile-config.ts";

test("writePiGatewayConfig emits contextWindow from provider modelMetadata", async () => {
  // Hermetic: a hand-built AppConfig subset (Providers + gateway) is passed in,
  // and configDir points at a temp dir, so the real ~/.claude-code-router and the
  // running gateway are never touched. The static model catalog is still resolved
  // from packages/core/models.json (cwd = repo root under the test runner).
  const config = {
    Providers: [
      {
        name: "openai",
        id: "openai",
        models: ["Qwen3.6-35B-A3B-4bit"],
        modelMetadata: {
          "Qwen3.6-35B-A3B-4bit": { contextWindow: 262144, maxContextWindow: 262144 }
        }
      },
      {
        name: "anthropic",
        id: "anthropic",
        models: ["claude-sonnet-5"]
        // No modelMetadata -> must fall back to the static catalog.
      },
      {
        name: "deepseek",
        id: "deepseek",
        models: ["deepseek-v4-pro"],
        modelMetadata: {
          "deepseek-v4-pro": { contextWindow: 131072 } // no maxContextWindow
        }
      },
      {
        name: "Fusion",
        id: "fusion",
        models: ["definitely-not-a-real-model-xyz"]
        // No metadata and not in the catalog -> contextWindow must be omitted.
      }
    ],
    virtualModelProfiles: [],
    gateway: { host: "127.0.0.1", port: 3456 }
  };

  const profile = {
    id: "pi",
    name: "pi",
    scope: "ccr",
    model: "openai/Qwen3.6-35B-A3B-4bit",
    enabled: true,
    agent: "pi"
  };

  const tmp = mkdtempSync(path.join(os.tmpdir(), "ccr-pi-context-window-"));
  try {
    const result = writePiGatewayConfig(
      tmp,
      config,
      profile,
      "hermetic-test-token",
      "openai/Qwen3.6-35B-A3B-4bit"
    );
    const modelsJson = JSON.parse(readFileSync(result.file, "utf8"));
    const models = modelsJson.providers["claude-code-router"].models;
    const byId = new Map(models.map((m) => [m.id, m]));

    // 1. maxContextWindow set -> exact metadata value (262144).
    assert.equal(byId.get("openai/Qwen3.6-35B-A3B-4bit").contextWindow, 262144);

    // 2. No metadata, catalog-known -> catalog value (claude-sonnet-5 = 1M),
    //    never pi's 128k default nor the hard 262144 fallback.
    const sonnet = byId.get("anthropic/claude-sonnet-5");
    assert.ok(sonnet.contextWindow !== undefined, "catalog-known model should get a contextWindow");
    assert.ok(sonnet.contextWindow > 0);
    assert.notEqual(sonnet.contextWindow, 128000);
    assert.notEqual(sonnet.contextWindow, 262144);

    // 3. Only contextWindow set (no maxContextWindow) -> falls back to contextWindow.
    assert.equal(byId.get("deepseek/deepseek-v4-pro").contextWindow, 131072);

    // 4. Truly-unknown model -> key omitted entirely (pi keeps its own default).
    const unknown = byId.get("Fusion/definitely-not-a-real-model-xyz");
    assert.ok(!("contextWindow" in unknown), "unknown model should omit contextWindow");
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});
