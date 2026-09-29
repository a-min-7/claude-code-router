import type { ProviderAccountConfig } from "@ccr/core/contracts/app";
import type { ProviderPreset } from "@ccr/core/providers/presets/types";

const deepSeekProviderAccountConfig: ProviderAccountConfig = {
  connectors: [
    {
      auth: "provider-api-key",
      endpoint: "https://api.deepseek.com/user/balance",
      mapping: {
        meters: [
          {
            id: "balance",
            kind: "balance",
            label: "Balance",
            remaining: "$.balance_infos[0].total_balance",
            unit: "$.balance_infos[0].currency"
          },
          {
            id: "granted_balance",
            kind: "balance",
            label: "Granted balance",
            remaining: "$.balance_infos[0].granted_balance",
            unit: "$.balance_infos[0].currency"
          },
          {
            id: "topped_up_balance",
            kind: "balance",
            label: "Topped-up balance",
            remaining: "$.balance_infos[0].topped_up_balance",
            unit: "$.balance_infos[0].currency"
          }
        ]
      },
      type: "http-json"
    }
  ],
  enabled: true
};

export const deepSeekProviderPreset: ProviderPreset = {
  account: deepSeekProviderAccountConfig,
  aliases: ["deepseek"],
  endpoints: [
    // Kept FIRST: `primaryProviderPresetEndpoint()` returns endpoints[0], and a provider's
    // api_base_url is derived from it. This is the surface the fleet's DeepSeek provider uses.
    {
      baseUrl: "https://api.deepseek.com",
      protocols: ["openai_chat_completions"]
    },
    // DeepSeek's Anthropic-compatible surface, for the SAME account and key. Declared here rather
    // than hand-added to a provider's `capabilities` in config because the supported path is
    // preset-driven (same reasoning as the zai-global-general preset): the probe builds candidates
    // from preset.endpoints, so this entry makes the probe PRODUCE the anthropic_messages
    // capability; a hand-added capability is merged against detected+preset on every re-probe and
    // can be silently dropped.
    //
    // Measured 2026-09-29 through the CCR gateway: a full tool-carrying conversation on
    // deepseek-flash over this surface returns 200 with thinking delivered to the client, and the
    // round-trip 400 the OpenAI surface documents does NOT fire for conversations whose tool_use
    // ids DeepSeek itself generated (5/5 repeats). Note: this surface ignores `cache_control`
    // (no prompt caching), unlike the OpenAI surface's automatic context caching.
    {
      baseUrl: "https://api.deepseek.com/anthropic",
      protocols: ["anthropic_messages"]
    }
  ],
  id: "deepseek",
  name: "DeepSeek",
  websiteUrl: "https://www.deepseek.com/"
};
