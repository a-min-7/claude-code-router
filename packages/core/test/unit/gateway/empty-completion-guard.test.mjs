import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEmptyCompletionGuardResponse,
  applyEmptyCompletionGuardStream,
  isSilentVoidResponse,
  isProtocolPseudoModel,
  messageHasContent
} from "@ccr/core/gateway/core-runtime/empty-completion-guard.ts";
import {
  ccrEmptyCompletionGuardResponseHookKey,
  ccrEmptyCompletionGuardStreamHookKey
} from "@ccr/core/gateway/core-runtime/router-plugin-contract.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";

/** The router-plugin factory requires the host config under plugin.config.appConfig. */
function loadGatewayPlugin() {
  return createGatewayPlugin({ plugin: { config: { appConfig: createDefaultAppConfig() } } });
}

/** OpenAI-shaped chat.completion payload. */
function openAi(message, extra = {}) {
  return { choices: [{ index: 0, message }], object: "chat.completion", ...extra };
}

/** Anthropic-shaped messages payload. */
function anthropic(content) {
  return { content, role: "assistant", type: "message" };
}

// --- the defect ------------------------------------------------------------

test("a 200 with empty content is reclassified as 502", () => {
  const result = applyEmptyCompletionGuardResponse({
    model: "deepseek-flash",
    statusCode: 200,
    responsePayload: openAi({ role: "assistant", content: "" })
  });
  assert.equal(result?.statusCode, 502);
  assert.equal(result?.responsePayload?.error?.code, "ccr_empty_completion");
});

test("a 200 with content [] is reclassified as 502", () => {
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "glm-5.3",
      statusCode: 200,
      responsePayload: anthropic([])
    })?.statusCode,
    502
  );
});

test("a 200 with an empty text block only is reclassified as 502", () => {
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "glm-5.3",
      statusCode: 200,
      responsePayload: anthropic([{ type: "text", text: "" }])
    })?.statusCode,
    502
  );
});

// --- the refusal cases (these are what keep the guard safe) ----------------

test("REGRESSION: a real answer with NO usage block is NOT touched (row 40293 shape)", () => {
  // Emmy request-logs id 40293: 2,745 bytes of real content, logged with
  // input_tokens=0 output_tokens=0 because the upstream sent no `usage` at all.
  // A token-keyed guard would 502 this. It must pass through.
  const payload = openAi({
    role: "assistant",
    content: "# Zero-Output Tokens Analysis\n\n## Task 1: Count\n…",
    reasoning_content: "Let me summarize all the results…"
  });
  assert.equal(isSilentVoidResponse({ model: "nemotron-lightning-30b", statusCode: 200, responsePayload: payload }), false);
  assert.equal(
    applyEmptyCompletionGuardResponse({ model: "nemotron-lightning-30b", statusCode: 200, responsePayload: payload }),
    undefined
  );
});

test("REGRESSION: a tool-only turn (empty text, tool_calls present) is NOT touched", () => {
  // Measured 2026-09-18: a real tool-only turn returned content [thinking, tool_use]
  // with NO text block, and consumed 101 output tokens. It is a legitimate answer.
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "Qwen3.6-35B-A3B-oQ4-mtp",
      statusCode: 200,
      responsePayload: openAi({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }]
      })
    }),
    undefined
  );
  // Anthropic-shaped equivalent: a tool_use block with no text.
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "Qwen3.6-35B-A3B-oQ4-mtp",
      statusCode: 200,
      responsePayload: anthropic([{ type: "tool_use", id: "toolu_1", name: "ls", input: {} }])
    }),
    undefined
  );
});

test("REGRESSION: reasoning-only content is NOT touched (nemotron content:null trap)", () => {
  // --reasoning-parser nemotron_v3 can land a terse answer in `reasoning` with
  // content:null. Treating reasoning as absent would 502 a correct answer.
  assert.equal(messageHasContent({ content: null, reasoning_content: "The answer is 42." }), true);
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "nemotron-super-120b",
      statusCode: 200,
      responsePayload: openAi({ role: "assistant", content: null, reasoning_content: "The answer is 42." })
    }),
    undefined
  );
  assert.equal(messageHasContent({ content: null, reasoning: "The answer is 42." }), true);
});

test("REGRESSION: protocol pseudo-models are never reclassified", () => {
  assert.equal(isProtocolPseudoModel("keepalive"), true);
  assert.equal(isProtocolPseudoModel("provider-connectivity-check"), true);
  assert.equal(isProtocolPseudoModel("deepseek-flash"), false);
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "keepalive",
      statusCode: 200,
      responsePayload: openAi({ role: "assistant", content: "" })
    }),
    undefined
  );
});

test("non-200 responses are never touched", () => {
  for (const statusCode of [400, 401, 429, 500, 502, 503]) {
    assert.equal(
      applyEmptyCompletionGuardResponse({
        model: "deepseek-flash",
        statusCode,
        responsePayload: openAi({ role: "assistant", content: "" })
      }),
      undefined,
      `status ${statusCode} must pass through`
    );
  }
});

test("a 200 whose payload is not a recognisable completion is not judged", () => {
  // Health/config/other passthrough bodies are not ours.
  assert.equal(isSilentVoidResponse({ model: "x", statusCode: 200, responsePayload: { ok: true } }), false);
  assert.equal(isSilentVoidResponse({ model: "x", statusCode: 200, responsePayload: undefined }), false);
  assert.equal(isSilentVoidResponse({ model: "x", statusCode: 200, responsePayload: "plain text" }), false);
});

test("normal content passes through", () => {
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "glm-5.3",
      statusCode: 200,
      responsePayload: openAi({ role: "assistant", content: "Hello!" })
    }),
    undefined
  );
  assert.equal(
    applyEmptyCompletionGuardResponse({
      model: "glm-5.3",
      statusCode: 200,
      responsePayload: anthropic([{ type: "text", text: "Hello!" }])
    }),
    undefined
  );
});

// --- wiring: the statusCode must survive the hook boundary ------------------
// The local GatewayResponseHookInput alias types `statusCode` as optional, so a
// hook may return it and still typecheck while the engine drops it. These are the
// anti-silent-drop assertions.

test("the manifest registers the empty-completion guard response hook", async () => {
  const plugin = await loadGatewayPlugin();
  const keys = (plugin.responseHooks ?? []).map((hook) => hook.key);
  assert.ok(
    keys.includes(ccrEmptyCompletionGuardResponseHookKey),
    `expected ${ccrEmptyCompletionGuardResponseHookKey} among responseHooks: ${keys.join(", ")}`
  );
});

test("the registered hook returns a 502 statusCode, not just a payload", async () => {
  const plugin = await loadGatewayPlugin();
  const hook = (plugin.responseHooks ?? []).find((candidate) => candidate.key === ccrEmptyCompletionGuardResponseHookKey);
  assert.ok(hook, "hook not registered");
  const applied = await hook.transformResponse({
    model: "deepseek-flash",
    statusCode: 200,
    responsePayload: openAi({ role: "assistant", content: "" })
  });
  assert.equal(applied?.statusCode, 502, "the engine must be handed a statusCode, not only a payload");
  assert.equal(applied?.responsePayload?.error?.code, "ccr_empty_completion");
});

// --- streaming path (A3) ---------------------------------------------------

function streamResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" }, status: 200 });
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("a stream that ends with no content gains a synthetic error event", async () => {
  const guarded = applyEmptyCompletionGuardStream({
    model: "deepseek-flash",
    upstreamResponse: streamResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    ])
  });
  assert.ok(guarded, "an empty stream must be wrapped");
  const text = await drain(guarded);
  assert.ok(text.includes("event: error"), `expected a synthetic error event, got: ${text}`);
  assert.ok(text.includes("without producing any content"));
});

test("a completely empty stream (zero chunks) gains the error event", async () => {
  const guarded = applyEmptyCompletionGuardStream({
    model: "deepseek-flash",
    upstreamResponse: streamResponse([])
  });
  assert.ok(guarded);
  assert.ok((await drain(guarded)).includes("event: error"));
});

test("REGRESSION: a stream carrying content is NOT given an error event", async () => {
  const guarded = applyEmptyCompletionGuardStream({
    model: "Qwen3.6-35B-A3B-oQ4-mtp",
    upstreamResponse: streamResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'
    ])
  });
  assert.ok(guarded);
  const text = await drain(guarded);
  assert.ok(!text.includes("event: error"), "a content-bearing stream must pass through untouched");
  assert.ok(text.includes("Hello"), "the original content must survive");
});

test("REGRESSION: a reasoning-only stream counts as content", async () => {
  const guarded = applyEmptyCompletionGuardStream({
    model: "nemotron-super-120b",
    upstreamResponse: streamResponse(['data: {"type":"content_block_delta","delta":{"type":"thinking_delta"}}\n\n'])
  });
  assert.ok(guarded);
  assert.ok(!(await drain(guarded)).includes("event: error"));
});

test("a tool_use stream counts as content", async () => {
  const guarded = applyEmptyCompletionGuardStream({
    model: "Qwen3.6-35B-A3B-oQ4-mtp",
    upstreamResponse: streamResponse(['data: {"type":"content_block_start","content_block":{"type":"tool_use"}}\n\n'])
  });
  assert.ok(guarded);
  assert.ok(!(await drain(guarded)).includes("event: error"));
});

test("protocol pseudo-models and body-less responses are not wrapped", () => {
  assert.equal(
    applyEmptyCompletionGuardStream({ model: "keepalive", upstreamResponse: streamResponse([]) }),
    undefined
  );
  assert.equal(applyEmptyCompletionGuardStream({ model: "x", upstreamResponse: new Response(null) }), undefined);
  assert.equal(applyEmptyCompletionGuardStream({ model: "x", upstreamResponse: undefined }), undefined);
});

test("the manifest registers the empty-completion guard stream hook", async () => {
  const plugin = await loadGatewayPlugin();
  const keys = (plugin.streamHooks ?? []).map((hook) => hook.key);
  assert.ok(
    keys.includes(ccrEmptyCompletionGuardStreamHookKey),
    `expected ${ccrEmptyCompletionGuardStreamHookKey} among streamHooks: ${keys.join(", ")}`
  );
});
