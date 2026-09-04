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
