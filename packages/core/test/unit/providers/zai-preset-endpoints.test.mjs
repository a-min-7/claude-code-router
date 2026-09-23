import assert from "node:assert/strict";
import test from "node:test";
import {
  zaiGlobalCodingProviderPreset
} from "@ccr/core/providers/presets/zai-global-coding/index.ts";
import {
  zaiGlobalGeneralProviderPreset
} from "@ccr/core/providers/presets/zai-global-general/index.ts";
import { primaryProviderPresetEndpoint } from "@ccr/core/providers/presets/utils.ts";

// Z.ai serves the same account and key over two surfaces, and the preset is what declares them.
// The Anthropic Message Protocol entry on the GENERAL preset is load-bearing beyond display: the UI
// builds probe candidates from `preset.endpoints`, so this entry is what makes
// probeGatewayProviderCandidates() detect (and therefore retain) the `anthropic_messages`
// capability. Without it, adding the capability by hand to a provider is re-merged against
// detected+preset on every re-probe and can be silently dropped.

const anthropicBaseUrl = "https://api.z.ai/api/anthropic";
const paasBaseUrl = "https://api.z.ai/api/paas/v4";

function endpointFor(preset, baseUrl) {
  return (preset.endpoints ?? []).find((endpoint) => endpoint.baseUrl === baseUrl);
}

test("the general preset declares Z.ai's Anthropic Message Protocol endpoint", () => {
  const endpoint = endpointFor(zaiGlobalGeneralProviderPreset, anthropicBaseUrl);
  assert.ok(endpoint, `expected an endpoint for ${anthropicBaseUrl}`);
  assert.deepEqual(endpoint.protocols, ["anthropic_messages"]);
});

// Regression guard: a provider's api_base_url is derived from endpoints[0], and the fleet's Z.ai
// provider uses the paas/v4 base. Adding the Anthropic endpoint must not displace it.
test("the paas endpoint stays first on the general preset", () => {
  assert.equal(primaryProviderPresetEndpoint(zaiGlobalGeneralProviderPreset)?.baseUrl, paasBaseUrl);
});

// The two Z.ai presets must not drift apart on the Anthropic endpoint: same host, same protocol.
test("the general and coding presets agree on the Anthropic endpoint", () => {
  const general = endpointFor(zaiGlobalGeneralProviderPreset, anthropicBaseUrl);
  const coding = endpointFor(zaiGlobalCodingProviderPreset, anthropicBaseUrl);
  assert.deepEqual(general?.protocols, coding?.protocols);
  assert.equal(general?.baseUrl, coding?.baseUrl);
});

// A UI re-import falls back to `defaultModels` when discovery returns no models, so the 5.3 family
// has to be listed or a re-import can drop the models the fleet actually serves.
test("the general preset's default models include the 5.3 family", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    assert.ok(
      (zaiGlobalGeneralProviderPreset.defaultModels ?? []).includes(model),
      `${model} must be a default model of the general preset`
    );
  }
});

// …and the fork ADDS to the upstream list rather than replacing it.
test("the general preset keeps the upstream default models", () => {
  for (const model of ["glm-5.2", "glm-5.1", "glm-4.7", "glm-4.5-air"]) {
    assert.ok(
      (zaiGlobalGeneralProviderPreset.defaultModels ?? []).includes(model),
      `${model} must survive`
    );
  }
});
