/**
 * Empty-completion guard.
 *
 * The engine coerces absent assistant content to `""` and passes the upstream HTTP
 * status through untouched, so a provider that returns nothing still reaches the
 * client as **HTTP 200 with no content**. Observed cost: a 1 h 38 m stall on
 * 2026-09-14 — 20 requests, ~904 s each, zero tokens, every one recorded `status_code
 * 200` (Emmy `app-data/usage.sqlite`, ids 39933–39966). The client cannot distinguish
 * that from a legitimate empty answer, so it waits instead of failing.
 *
 * This hook reclassifies such a response as 502 so the client's error handling sees a
 * failure.
 *
 * ## Why the test is CONTENT-based and NOT token-based
 *
 * Token counts are not a reliable void signal. On 2026-09-18 a **2,745-byte** real
 * answer (a subagent's analysis) was logged with `input_tokens=0 output_tokens=0
 * reasoning_tokens=0 total_tokens=0`, because the upstream returned **no `usage` block
 * at all** (Emmy `app-data/request-logs.sqlite`, id 40293). A guard keyed on
 * `output_tokens === 0` would have 502'd that correct answer. Token fields mean
 * "usage was reported", not "content was produced".
 *
 * ## Reasoning counts as content
 *
 * Nemotron's `--reasoning-parser` can land a terse answer in `message.reasoning` with
 * `content: null`. Treating reasoning as absent would 502 a correct answer that simply
 * answered in the reasoning channel.
 */

/** Protocol pseudo-models that legitimately carry no completion. Never 502 these. */
const protocolPseudoModels = new Set(["keepalive", "provider-connectivity-check", "provider-connectivity"]);

/** Headers/fields that carry reasoning text, across the shapes we see. */
const reasoningKeys = ["reasoning_content", "reasoning"] as const;

export type EmptyCompletionGuardInput = {
  model?: string;
  statusCode?: number;
  responsePayload?: unknown;
};

export type EmptyCompletionGuardResult = {
  statusCode: number;
  responsePayload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when this model is protocol traffic, not a completion. */
export function isProtocolPseudoModel(model: string | undefined): boolean {
  if (typeof model !== "string") {
    return false;
  }
  return protocolPseudoModels.has(model.trim().toLowerCase());
}

/**
 * Pull the assistant message out of either payload shape:
 *   - OpenAI chat.completion: `{ choices: [{ message: {...} }] }`
 *   - Anthropic messages:     `{ content: [...] }`
 * Returns undefined when neither shape is recognisable.
 */
function assistantMessage(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (isRecord(first) && isRecord(first.message)) {
      return first.message;
    }
  }
  // Anthropic-shaped payloads put the blocks directly on `content`.
  if (Array.isArray(payload.content)) {
    return payload;
  }
  return undefined;
}

/** True when the message carries any text, reasoning, tool calls, or content blocks. */
export function messageHasContent(message: Record<string, unknown> | undefined): boolean {
  if (!message) {
    return false;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  for (const key of reasoningKeys) {
    if (nonEmptyString(message[key])) {
      return true;
    }
  }
  const content = message.content;
  if (nonEmptyString(content)) {
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (nonEmptyString(block)) {
        return true;
      }
      if (!isRecord(block)) {
        return false;
      }
      // Any block counts unless it is explicitly an empty text block.
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type === "text") {
        return nonEmptyString(block.text);
      }
      return true;
    });
  }
  return false;
}

/**
 * The predicate. Returns true when a 200 response carries no completion at all.
 *
 * Deliberately silent on token counts — see the module docstring.
 */
export function isSilentVoidResponse(input: EmptyCompletionGuardInput): boolean {
  if (input.statusCode !== 200) {
    return false;
  }
  if (isProtocolPseudoModel(input.model)) {
    return false;
  }
  const message = assistantMessage(input.responsePayload);
  if (!message) {
    // A 200 whose payload is not a recognisable completion is not ours to judge:
    // the engine may be passing through a non-completion body (health, config, etc.).
    return false;
  }
  return !messageHasContent(message);
}

/** Normalised error body, matching the shape the engine already emits for failures. */
export function emptyCompletionErrorPayload(model: string | undefined): unknown {
  return {
    error: {
      code: "ccr_empty_completion",
      message:
        "Upstream returned an empty completion: no content, no reasoning, and no tool calls " +
        `(model: ${model ?? "unknown"}).`,
      type: "upstream_error"
    }
  };
}

/**
 * responseHooks entry point. Returns the replacement transform value on a void,
 * otherwise undefined so the response passes through untouched (matching the contract
 * of the sibling hooks in router-plugin.ts).
 */
export function applyEmptyCompletionGuardResponse(
  input: EmptyCompletionGuardInput
): EmptyCompletionGuardResult | undefined {
  if (!isSilentVoidResponse(input)) {
    return undefined;
  }
  return {
    statusCode: 502,
    responsePayload: emptyCompletionErrorPayload(input.model)
  };
}

// ---------------------------------------------------------------------------
// Streaming path (A3)
//
// The engine dispatches responseHooks and streamHooks on SEPARATE paths, and it is
// not statically determinable which one a given /v1/messages request takes: the
// `request_logs.is_stream` column says 178 non-stream vs 1 stream, while the request
// BODIES say 124 of 181 set `"stream": true`. The column is not trustworthy. Rather
// than bet on one path, cover both.
//
// Streaming cannot be reclassified after the fact — the status line is already on the
// wire. So the guard instead appends a synthetic error event when a stream ends
// without ever carrying content, which the client surfaces as an API error.
//
// ⚠️ This path's predicate was Anthropic-only until 2026-10-05, which made it fire on
// EVERY openai_chat stream. See openAiStreamContentPattern for the measurement.
// ---------------------------------------------------------------------------

/** SSE markers that mean the stream actually carried model output (Anthropic EVENT NAMES). */
const streamContentMarkers = [
  "content_block_delta",
  "input_json_delta",
  "thinking_delta",
  "text_delta",
  "tool_use"
] as const;

/**
 * OpenAI-shaped stream markers.
 *
 * The list above is Anthropic *event names*. An `openai_chat` upstream streams one
 * `chat.completion.chunk` per delta and contains none of them, so every such stream was
 * judged empty and had a synthetic error event appended — including turns that carried a
 * tool call and reasoning.
 *
 * Measured 2026-10-05, `grace` provider (`provider-grace-3a6785346f::openai_chat_completions`,
 * model `nemotron-super-120b`): 95 of 97 requests were logged `ok=0` with this guard's
 * message while their captured bodies carried `{"delta":{"reasoning":"…"}}` and
 * `{"delta":{"tool_calls":[{"type":"function","index":0,"function":{"name":"Bash"}}]}}`
 * and ended `finish_reason:"tool_calls"`. The client consumed the tool calls normally —
 * only the ledger `ok` flag and the trailing `event: error` were wrong. The docstring's
 * rule that "reasoning counts as content" was implemented for the response path and
 * never for this one.
 *
 * Each alternative requires a value that cannot be the EMPTY form, so the guard is not
 * weakened: `"tool_calls":[{` cannot match `"tool_calls":null` or `[]`, `"reasoning":"x`
 * cannot match `"reasoning":""`, and `"content":"x` cannot match the role-announcement
 * delta's `"content":""`.
 */
const openAiStreamContentPattern =
  /"tool_calls"\s*:\s*\[\s*\{|"reasoning(?:_content)?"\s*:\s*"[^"]|"content"\s*:\s*"[^"]/;

/**
 * A marker can straddle a chunk boundary — `streamCarriesContent` sees one chunk at a
 * time — so each check also sees the tail of the preceding chunks. 256 chars covers the
 * longest marker with room to spare.
 */
const streamMarkerTailChars = 256;

function streamCarriesContent(text: string): boolean {
  return streamContentMarkers.some((marker) => text.includes(marker)) || openAiStreamContentPattern.test(text);
}

/** Synthetic terminal error event for a stream that produced nothing. */
export function emptyCompletionStreamErrorEvent(model: string | undefined): string {
  const payload = {
    type: "error",
    error: {
      type: "api_error",
      message:
        "Upstream stream ended without producing any content (no text, reasoning, or tool calls). " +
        `(model: ${model ?? "unknown"})`
    }
  };
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

export type EmptyCompletionStreamGuardInput = {
  model?: string;
  upstreamResponse?: { body?: ReadableStream<Uint8Array> | null; status?: number; statusText?: string; headers?: Headers };
};

/**
 * streamHooks entry point. Wraps the upstream body and, on a stream that ends with no
 * content-bearing event, appends a synthetic error event. Returns undefined when the
 * response cannot be a void (protocol pseudo-model, no body) so the stream passes
 * through untouched.
 */
export function applyEmptyCompletionGuardStream(
  input: EmptyCompletionStreamGuardInput
): Response | undefined {
  const upstream = input.upstreamResponse;
  if (!upstream?.body) {
    return undefined;
  }
  if (isProtocolPseudoModel(input.model)) {
    return undefined;
  }
  const decoder = new TextDecoder();
  let sawContent = false;
  let tail = "";
  const wrapped = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sawContent) {
          const text = tail + decoder.decode(chunk, { stream: true });
          if (streamCarriesContent(text)) {
            sawContent = true;
          }
          tail = text.slice(-streamMarkerTailChars);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (!sawContent) {
          controller.enqueue(new TextEncoder().encode(emptyCompletionStreamErrorEvent(input.model)));
        }
      }
    })
  );
  return new Response(wrapped, {
    headers: upstream.headers,
    status: upstream.status ?? 200,
    statusText: upstream.statusText
  });
}
