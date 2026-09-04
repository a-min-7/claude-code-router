import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaiGlm53ReasoningEffort } from "@ccr/core/gateway/upstream/executor.ts";

function buf(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function parse(b) {
  return b ? JSON.parse(b.toString("utf8")) : undefined;
}

const zaiProvider = { id: "z.ai-global---general-endpoint", name: "Z.ai (Global) - General Endpoint", api_base_url: "https://api.z.ai/api/paas/v4", models: ["glm-5.3", "glm-5.3-flash", "glm-5.2"] };
const deepseekProvider = { id: "deepseek", name: "DeepSeek", api_base_url: "https://api.deepseek.com", models: ["deepseek-v4-pro"] };

test("maps output_config.effort medium → high for glm-5.3", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "medium" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.output_config.effort, "high");
  assert.equal(out.reasoning_effort, "high");
});

test("maps output_config.effort medium → high for glm-5.3-flash", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3-flash", messages: [], output_config: { effort: "medium" } }),
    provider: zaiProvider,
    model: "glm-5.3-flash"
  }));
  assert.equal(out.output_config.effort, "high");
  assert.equal(out.reasoning_effort, "high");
});

test("maps reasoning_effort medium → high for glm-5.3 (post-conversion field)", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], reasoning_effort: "medium" }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.reasoning_effort, "high");
});

test("maps effort none → low", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "none" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.reasoning_effort, "low");
  assert.equal(out.output_config.effort, "low");
});

test("maps effort minimal → low", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "minimal" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.reasoning_effort, "low");
});

test("maps effort xhigh → max", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "xhigh" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.reasoning_effort, "max");
  assert.equal(out.output_config.effort, "max");
});

test("leaves effort max unchanged (already valid)", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "max" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.output_config.effort, "max");
  assert.equal(out.reasoning_effort, "max");
});

test("leaves effort low unchanged (already valid)", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "low" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.equal(out.output_config.effort, "low");
  assert.equal(out.reasoning_effort, "low");
});

test("leaves effort absent unchanged (Z.ai default = max)", () => {
  const orig = buf({ model: "glm-5.3", messages: [], stream: true });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: zaiProvider, model: "glm-5.3" }), orig);
});

test("does NOT clamp on DeepSeek (effort medium stays medium)", () => {
  const orig = buf({ model: "deepseek-v4-pro", messages: [], output_config: { effort: "medium" } });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: deepseekProvider, model: "deepseek-v4-pro" }), orig);
});

test("does NOT clamp on Z.ai glm-5.2 (accepts medium)", () => {
  const orig = buf({ model: "glm-5.2", messages: [], output_config: { effort: "medium" } });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: zaiProvider, model: "glm-5.2" }), orig);
});

test("thinking disabled → removed, reasoning_effort set to low", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], thinking: { type: "disabled" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.ok(!("thinking" in out), "thinking field removed");
  assert.equal(out.reasoning_effort, "low");
});

test("enable_thinking false → removed, reasoning_effort set to low", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], enable_thinking: false }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.ok(!("enable_thinking" in out), "enable_thinking removed");
  assert.equal(out.reasoning_effort, "low");
});

test("enable_thinking true → removed, no reasoning_effort added", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], enable_thinking: true }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.ok(!("enable_thinking" in out), "enable_thinking removed");
  assert.ok(!("reasoning_effort" in out), "no reasoning_effort added (provider default)");
});

test("disable intent does not override an explicit valid effort", () => {
  const out = parse(normalizeZaiGlm53ReasoningEffort({
    body: buf({ model: "glm-5.3", messages: [], output_config: { effort: "high" }, thinking: { type: "disabled" } }),
    provider: zaiProvider,
    model: "glm-5.3"
  }));
  assert.ok(!("thinking" in out));
  assert.equal(out.reasoning_effort, "high");
});

test("returns body unchanged when no relevant fields present", () => {
  const orig = buf({ model: "glm-5.3", messages: [], stream: true, max_tokens: 100 });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: zaiProvider, model: "glm-5.3" }), orig);
});

test("returns body unchanged when provider is undefined", () => {
  const orig = buf({ model: "glm-5.3", messages: [], output_config: { effort: "medium" } });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: undefined, model: "glm-5.3" }), orig);
});

test("returns body unchanged when model is undefined", () => {
  const orig = buf({ model: "glm-5.3", messages: [], output_config: { effort: "medium" } });
  assert.equal(normalizeZaiGlm53ReasoningEffort({ body: orig, provider: zaiProvider, model: undefined }), orig);
});
