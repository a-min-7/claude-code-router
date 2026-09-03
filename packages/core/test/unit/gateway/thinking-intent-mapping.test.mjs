import assert from "node:assert/strict";
import test from "node:test";
import { stripUnsupportedOpenAiRequestParameters, thinkingIntentToEnableThinking } from "@ccr/core/gateway/upstream/executor.ts";

function buf(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function parse(b) {
  return b ? JSON.parse(b.toString("utf8")) : undefined;
}

test("thinkingIntentToEnableThinking maps explicit on/off intents", () => {
  assert.equal(thinkingIntentToEnableThinking(true), true);
  assert.equal(thinkingIntentToEnableThinking(false), false);
  assert.equal(thinkingIntentToEnableThinking({ type: "enabled" }), true);
  assert.equal(thinkingIntentToEnableThinking({ type: "disabled" }), false);
  assert.equal(thinkingIntentToEnableThinking({ enabled: true }), true);
  assert.equal(thinkingIntentToEnableThinking({ enabled: "true" }), true);
  assert.equal(thinkingIntentToEnableThinking({ enabled: "false" }), false);
  assert.equal(thinkingIntentToEnableThinking({ enabled: false }), false);
  assert.equal(thinkingIntentToEnableThinking({ type: "enabled", budget_tokens: 1024 }), true);
});

test("thinkingIntentToEnableThinking is fail-open (undefined) on unclear intents", () => {
  assert.equal(thinkingIntentToEnableThinking(undefined), undefined);
  assert.equal(thinkingIntentToEnableThinking(null), undefined);
  assert.equal(thinkingIntentToEnableThinking({}), undefined);
  assert.equal(thinkingIntentToEnableThinking({ type: "weird" }), undefined);
  assert.equal(thinkingIntentToEnableThinking({ enabled: "banana" }), undefined);
  assert.equal(thinkingIntentToEnableThinking("enabled"), undefined);
  assert.equal(thinkingIntentToEnableThinking(42), undefined);
});

test("stripUnsupported maps a disabled thinking intent to enable_thinking:false", () => {
  const out = parse(stripUnsupportedOpenAiRequestParameters(buf({ model: "m", thinking: { type: "disabled" }, max_tokens: 5 })));
  assert.equal(out.enable_thinking, false);
  assert.ok(!("thinking" in out), "thinking field removed");
  assert.equal(out.model, "m");
});

test("stripUnsupported maps an enabled thinking intent to enable_thinking:true", () => {
  const out = parse(stripUnsupportedOpenAiRequestParameters(buf({ model: "m", thinking: { type: "enabled", budget_tokens: 1024 } })));
  assert.equal(out.enable_thinking, true);
  assert.ok(!("thinking" in out));
});

test("stripUnsupported accepts boolean and {enabled} intents", () => {
  assert.equal(parse(stripUnsupportedOpenAiRequestParameters(buf({ thinking: true }))).enable_thinking, true);
  assert.equal(parse(stripUnsupportedOpenAiRequestParameters(buf({ thinking: { enabled: false } }))).enable_thinking, false);
});

test("stripUnsupported strips reasoning_split without adding enable_thinking", () => {
  const out = parse(stripUnsupportedOpenAiRequestParameters(buf({ model: "m", reasoning_split: { something: 1 } })));
  assert.ok(!("reasoning_split" in out));
  assert.ok(!("enable_thinking" in out), "no intent -> no enable_thinking (provider default)");
});

test("stripUnsupported returns the body unchanged when no thinking/reasoning_split present", () => {
  const orig = buf({ model: "m", messages: [], stream: true });
  assert.equal(stripUnsupportedOpenAiRequestParameters(orig), orig);
});

test("stripUnsupported fails open (drops thinking, no enable_thinking) on unclear intent", () => {
  const out = parse(stripUnsupportedOpenAiRequestParameters(buf({ model: "m", thinking: { nonsense: 1 } })));
  assert.ok(!("thinking" in out));
  assert.ok(!("enable_thinking" in out));
});
