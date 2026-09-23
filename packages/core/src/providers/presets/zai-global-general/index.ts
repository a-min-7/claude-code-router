import type { ProviderAccountConfig, ProviderAccountMappingConfig } from "@ccr/core/contracts/app";
import type { ProviderPreset } from "@ccr/core/providers/presets/types";

const zaiQuotaMapping: ProviderAccountMappingConfig = {
  meters: [
    {
      id: "five_hour_quota",
      kind: "quota",
      label: "5h quota",
      limit: 100,
      remaining: "100 - $.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==3)].percentage",
      resetAt: "$.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==3)].nextResetTime",
      unit: "%",
      used: "$.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==3)].percentage",
      window: "5h"
    },
    {
      id: "weekly_quota",
      kind: "quota",
      label: "Weekly quota",
      limit: 100,
      remaining: "100 - $.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==6)].percentage",
      resetAt: "$.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==6)].nextResetTime",
      unit: "%",
      used: "$.data.limits[?(@.type==\"TOKENS_LIMIT\" && @.unit==6)].percentage",
      window: "weekly"
    }
  ]
};

const zaiGlobalProviderAccountConfig: ProviderAccountConfig = {
  connectors: [
    {
      auth: "provider-api-key-raw",
      endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
      headers: {
        "Accept-Language": "en-US,en"
      },
      mapping: zaiQuotaMapping,
      type: "http-json"
    }
  ],
  enabled: true
};

export const zaiGlobalGeneralProviderPreset: ProviderPreset = {
  account: zaiGlobalProviderAccountConfig,
  aliases: ["z.ai", "zai", "z ai", "z-ai", "glm global"],
  // glm-5.3 / glm-5.3-flash are prepended for this fork: the 5.3 family is what the fleet's Z.ai
  // provider actually serves, and a UI re-import falls back to this list whenever discovery returns
  // no models (`mergeProviderModelLists(payload.models.length > 0 ? payload.models : preset?.defaultModels)`,
  // pages/home/shared/providers.ts). Listing them here is what keeps a re-import from silently
  // dropping them; the upstream entries are retained so nothing is lost either.
  defaultModels: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-4.7", "glm-4.5-air"],
  endpoints: [
    // Kept FIRST: `primaryProviderPresetEndpoint()` returns endpoints[0], and a provider's
    // api_base_url is derived from it — this is the base the fleet's Z.ai provider already uses.
    {
      baseUrl: "https://api.z.ai/api/paas/v4",
      protocols: ["openai_chat_completions"]
    },
    // Z.ai's Anthropic Message Protocol surface, for the SAME account and key. Declared here (as
    // zai-global-coding already does) rather than hand-added to a provider's `capabilities` in
    // config.sqlite, because the supported path is preset-driven: the UI builds probe candidates
    // from preset.endpoints (`preset.endpoints.map(...)`, pages/home/shared/providers.ts) and
    // probeGatewayProviderCandidates() then probes each candidate's declared protocols, so this
    // entry makes the probe PRODUCE the capability. A hand-added capability is instead merged
    // against detected+preset on every re-probe, i.e. it can be silently dropped.
    //
    // Measured 2026-09-23 against api.z.ai/api/anthropic with this account's key: HTTP 200 for
    // `glm-5.3` and `glm-5.3-flash`, contradicting the docs' GLM Coding Plan restriction.
    {
      baseUrl: "https://api.z.ai/api/anthropic",
      protocols: ["anthropic_messages"]
    }
  ],
  id: "zai-global-general",
  name: "Z.ai (Global) - General Endpoint",
  websiteUrl: "https://z.ai/"
};
