import assert from "node:assert/strict";
import test from "node:test";
import { coreGatewayProviderSelectorNameForTest } from "@ccr/core/gateway/core-runtime/router-plugin.ts";

/**
 * A provider whose runtime id lowercases to the same string as its public name is the case
 * that broke surface selection: a bare `Provider/model` pin carries no surface information,
 * and honouring it verbatim makes the engine take the provider's FIRST capability slice.
 *
 * These fixtures are shaped like the live DeepSeek entry (four capabilities, openai first,
 * anthropic second, `api_key` but no `credentials` array), because that ordering is what makes
 * the bug reproducible rather than theoretical.
 */
const deepseek = {
  api_base_url: "https://api.deepseek.com",
  api_key: "test-key",
  capabilities: [
    { baseUrl: "https://api.deepseek.com", endpoint: "https://api.deepseek.com/chat/completions", source: "detected", type: "openai_chat_completions" },
    { baseUrl: "https://api.deepseek.com/anthropic", endpoint: "https://api.deepseek.com/anthropic/v1/messages", source: "detected", type: "anthropic_messages" }
  ],
  id: "deepseek",
  models: ["deepseek-flash"],
  name: "DeepSeek",
  type: "openai_chat_completions"
};

/** Same multi-capability shape, but the public name does NOT lowercase to the runtime id. */
const zai = {
  api_base_url: "https://api.z.ai/api/paas/v4",
  api_key: "test-key",
  capabilities: [
    { baseUrl: "https://api.z.ai/api/paas/v4", endpoint: "https://api.z.ai/api/paas/v4/chat/completions", source: "detected", type: "openai_chat_completions" },
    { baseUrl: "https://api.z.ai/api/anthropic", endpoint: "https://api.z.ai/api/anthropic/v1/messages", source: "detected", type: "anthropic_messages" }
  ],
  id: "z.ai-global---general-endpoint",
  models: ["glm-5.3"],
  name: "Z.ai (Global) - General Endpoint",
  type: "openai_chat_completions"
};

test("REGRESSION: a bare runtime-id pin takes the client-preferred capability, not the first slice", () => {
  // `DeepSeek` lowercases to the runtime id `deepseek`, so this selector is the bare-id case.
  // Before the fix this returned the raw name and the engine used openai_chat_completions.
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages", "DeepSeek"),
    "deepseek::anthropic_messages"
  );
  assert.notEqual(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages", "DeepSeek"),
    "DeepSeek"
  );
});

test("the same bare runtime-id pin yields the OTHER surface for a chat-completions client", () => {
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "openai_chat_completions", "DeepSeek"),
    "deepseek::openai_chat_completions"
  );
});

test("an explicit capability selector is still honoured verbatim", () => {
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages", "deepseek::anthropic_messages"),
    "deepseek::anthropic_messages"
  );
});

test("an explicit credential selector is still honoured verbatim", () => {
  const requested = "deepseek::anthropic_messages::cred:key-1";
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages", requested),
    requested
  );
});

test("a non-colliding public name keeps taking the client-preferred capability (Z.ai shape)", () => {
  // Unchanged by the fix, but pinned: this is the path Z.ai's pins have always taken.
  assert.equal(
    coreGatewayProviderSelectorNameForTest(zai, "anthropic_messages", "Z.ai (Global) - General Endpoint"),
    "z.ai-global---general-endpoint::anthropic_messages"
  );
});

test("no requested provider name falls back to the capability-derived name", () => {
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages"),
    "deepseek::anthropic_messages"
  );
});

test("KNOWN LIMITATION: an explicit non-preferred slice is still overridden by the client protocol", () => {
  // Documented, not desired. `isCoreGatewayRuntimeProviderName` matches a slice name only
  // against the CLIENT-DERIVED protocol, so an anthropic client asking for the openai slice
  // by name is still resolved to the anthropic one. The consequence of demoting the bare
  // runtime id is therefore that a Claude Code client has NO model-selector route to a
  // non-anthropic surface. Left as-is deliberately: widening it is a separate change, and
  // for DeepSeek the anthropic surface is the one the vendor prescribes for this client.
  assert.equal(
    coreGatewayProviderSelectorNameForTest(deepseek, "anthropic_messages", "deepseek::openai_chat_completions"),
    "deepseek::anthropic_messages"
  );
});

test("a provider with no capability for the client protocol resolves to undefined", () => {
  const anthropicOnly = {
    api_key: "test-key",
    capabilities: [{ baseUrl: "https://x.example/anthropic", type: "anthropic_messages" }],
    id: "x",
    models: ["m"],
    name: "X",
    type: "anthropic_messages"
  };
  assert.equal(coreGatewayProviderSelectorNameForTest(anthropicOnly, "gemini_generate_content"), undefined);
});
