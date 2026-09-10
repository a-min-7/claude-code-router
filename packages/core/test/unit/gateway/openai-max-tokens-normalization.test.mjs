import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenAiMaxTokensParameter } from "@ccr/core/gateway/upstream/executor.ts";

function buf(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function parse(b) {
  return b ? JSON.parse(b.toString("utf8")) : undefined;
}

const openaiProvider = { id: "openai", name: "OpenAI", api_base_url: "https://api.openai.com/v1", models: ["gpt-5.5"] };
const deepseekProvider = { id: "deepseek", name: "DeepSeek", api_base_url: "https://api.deepseek.com", models: ["deepseek-v4-flash"] };

test("renames max_tokens to max_completion_tokens for OpenAI", () => {
  const body = buf({ model: "gpt-5.5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] });
  const out = parse(normalizeOpenAiMaxTokensParameter({ body, provider: openaiProvider, model: "gpt-5.5" }));
  assert.ok(!("max_tokens" in out), "legacy max_tokens removed");
  assert.equal(out.max_completion_tokens, 32);
  assert.equal(out.messages.length, 1);
});

test("does not touch bodies without max_tokens", () => {
  const orig = buf({ model: "gpt-5.5", messages: [] });
  assert.equal(normalizeOpenAiMaxTokensParameter({ body: orig, provider: openaiProvider, model: "gpt-5.5" }), orig);
});

test("explicit max_completion_tokens wins over legacy max_tokens", () => {
  const body = buf({ model: "gpt-5.5", max_tokens: 32, max_completion_tokens: 64, messages: [] });
  const out = parse(normalizeOpenAiMaxTokensParameter({ body, provider: openaiProvider, model: "gpt-5.5" }));
  assert.ok(!("max_tokens" in out));
  assert.equal(out.max_completion_tokens, 64);
});

test("does not touch non-OpenAI providers", () => {
  const body = buf({ model: "deepseek-v4-flash", max_tokens: 32, messages: [] });
  const out = normalizeOpenAiMaxTokensParameter({ body, provider: deepseekProvider, model: "deepseek-v4-flash" });
  assert.equal(out, body, "unchanged buffer returned");
});

test("returns body unchanged when provider is undefined", () => {
  const orig = buf({ model: "gpt-5.5", max_tokens: 32, messages: [] });
  assert.equal(normalizeOpenAiMaxTokensParameter({ body: orig, provider: undefined, model: "gpt-5.5" }), orig);
});
