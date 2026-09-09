import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUnsupportedToolSchemaPatterns } from "@ccr/core/gateway/upstream/executor.ts";

function buf(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function parse(b) {
  return b ? JSON.parse(b.toString("utf8")) : undefined;
}

const deepseekProvider = { id: "deepseek", name: "DeepSeek", api_base_url: "https://api.deepseek.com", models: ["deepseek-v4-pro"] };
const zaiProvider = { id: "z.ai-global---general-endpoint", name: "Z.ai (Global) - General Endpoint", api_base_url: "https://api.z.ai/api/paas/v4", models: ["glm-5.3-flash"] };
const wangfuProvider = { id: "provider-wangfu-83a5fec123", name: "wangfu", api_base_url: "http://127.0.0.1:8000/v1", models: ["Qwen3.6-35B-A3B-oQ4-mtp"] };

const artifactPattern = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$";

test("strips \\p{...} pattern from Anthropic-format tool input_schema for DeepSeek", () => {
  const body = buf({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      name: "Artifact",
      description: "render",
      input_schema: {
        type: "object",
        properties: {
          field: { type: "string", pattern: artifactPattern }
        }
      }
    }]
  });
  const out = parse(sanitizeUnsupportedToolSchemaPatterns({ body, provider: deepseekProvider, model: "deepseek-v4-flash" }));
  assert.ok(!("pattern" in out.tools[0].input_schema.properties.field), "pattern dropped");
});

test("keeps ordinary (non-\\p) patterns intact", () => {
  const body = buf({
    model: "deepseek-v4-flash",
    messages: [],
    tools: [{
      name: "Artifact",
      input_schema: {
        type: "object",
        properties: {
          collection: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" },
          field: { type: "string", pattern: artifactPattern }
        }
      }
    }]
  });
  const out = parse(sanitizeUnsupportedToolSchemaPatterns({ body, provider: deepseekProvider, model: "deepseek-v4-flash" }));
  assert.equal(out.tools[0].input_schema.properties.collection.pattern, "^[A-Za-z0-9_-]{1,200}$");
  assert.ok(!("pattern" in out.tools[0].input_schema.properties.field));
});

test("strips \\p{...} pattern from OpenAI-format function parameters for Z.ai", () => {
  const body = buf({
    model: "glm-5.3-flash",
    messages: [],
    tools: [{
      type: "function",
      function: {
        name: "Artifact",
        parameters: {
          type: "object",
          properties: {
            field: { type: "string", pattern: artifactPattern }
          }
        }
      }
    }]
  });
  const out = parse(sanitizeUnsupportedToolSchemaPatterns({ body, provider: zaiProvider, model: "glm-5.3-flash" }));
  assert.ok(!("pattern" in out.tools[0].function.parameters.properties.field), "pattern dropped for Z.ai");
});

test("does not touch providers that accept Unicode property escapes (wangfu)", () => {
  const body = buf({
    model: "Qwen3.6-35B-A3B-oQ4-mtp",
    messages: [],
    tools: [{
      name: "Artifact",
      input_schema: {
        properties: { field: { type: "string", pattern: artifactPattern } }
      }
    }]
  });
  const out = sanitizeUnsupportedToolSchemaPatterns({ body, provider: wangfuProvider, model: "Qwen3.6-35B-A3B-oQ4-mtp" });
  assert.equal(out, body, "unchanged buffer returned for lenient provider");
});

test("returns body unchanged when provider is undefined", () => {
  const orig = buf({ model: "x", messages: [], tools: [{ name: "Artifact", input_schema: { properties: { field: { pattern: artifactPattern } } } }] });
  assert.equal(sanitizeUnsupportedToolSchemaPatterns({ body: orig, provider: undefined, model: "x" }), orig);
});

test("returns body unchanged when no \\p{...} pattern is present", () => {
  const orig = buf({ model: "deepseek-v4-flash", messages: [], tools: [{ name: "Bash", input_schema: { properties: { command: { type: "string" } } } }] });
  assert.equal(sanitizeUnsupportedToolSchemaPatterns({ body: orig, provider: deepseekProvider, model: "deepseek-v4-flash" }), orig);
});
