import assert from "node:assert/strict";
import test from "node:test";
import { isZaiForcedThinkingModel } from "@ccr/core/mcp/zai-forced-thinking-models.ts";

test("isZaiForcedThinkingModel detects glm-5.3", () => {
  assert.equal(isZaiForcedThinkingModel("glm-5.3"), true);
});

test("isZaiForcedThinkingModel detects glm-5.3-flash", () => {
  assert.equal(isZaiForcedThinkingModel("glm-5.3-flash"), true);
});

test("isZaiForcedThinkingModel is case-insensitive", () => {
  assert.equal(isZaiForcedThinkingModel("GLM-5.3"), true);
  assert.equal(isZaiForcedThinkingModel("GLM-5.3-Flash"), true);
});

test("isZaiForcedThinkingModel trims whitespace", () => {
  assert.equal(isZaiForcedThinkingModel("  glm-5.3  "), true);
});

test("isZaiForcedThinkingModel rejects non-forced-thinking models", () => {
  assert.equal(isZaiForcedThinkingModel("glm-5.2"), false);
  assert.equal(isZaiForcedThinkingModel("glm-4.5-air"), false);
  assert.equal(isZaiForcedThinkingModel("glm-5"), false);
  assert.equal(isZaiForcedThinkingModel("deepseek-v4-pro"), false);
  assert.equal(isZaiForcedThinkingModel("qwen3.6"), false);
});

test("isZaiForcedThinkingModel rejects undefined/empty", () => {
  assert.equal(isZaiForcedThinkingModel(undefined), false);
  assert.equal(isZaiForcedThinkingModel(""), false);
});

// CCR addresses models as "<Provider>/<model>" and that is exactly what the
// resolver is configured with (TOOLHUB_OPENAI_MODEL). Matching bare ids only
// made this guard a no-op in production, so the resolver kept sending
// enable_thinking:false and Z.ai answered 400 code 1210 on every resolve.
test("isZaiForcedThinkingModel detects a provider-prefixed glm-5.3", () => {
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/glm-5.3"), true);
});

test("isZaiForcedThinkingModel detects a provider-prefixed glm-5.3-flash", () => {
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/glm-5.3-flash"), true);
});

test("isZaiForcedThinkingModel handles prefix, case and whitespace together", () => {
  assert.equal(isZaiForcedThinkingModel("  Z.ai (Global) - General Endpoint/GLM-5.3-Flash  "), true);
});

test("isZaiForcedThinkingModel matches the segment after the last slash, not a prefix", () => {
  assert.equal(isZaiForcedThinkingModel("SomeProvider/glm-5.3"), true);
  // A model that merely ends in a matching substring must not match.
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/not-glm-5.3"), false);
});

test("isZaiForcedThinkingModel does not over-match other prefixed Z.ai models", () => {
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/glm-5.2"), false);
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/glm-5"), false);
  assert.equal(isZaiForcedThinkingModel("Z.ai (Global) - General Endpoint/glm-4.5-air"), false);
  assert.equal(isZaiForcedThinkingModel("DeepSeek/deepseek-flash"), false);
});
