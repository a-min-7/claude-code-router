# RFC: `<CCR-SUBAGENT-THINKING>` Sibling Tag — Implementation Scope

**Status:** Implemented 2026-09-03 (P0 + P1). Feature commits `188b990` (feat) + `1d8e352`
(tests) via PR a-min-7/claude-code-router#1; docs (en + zh) in routing.md "Subagent thinking
level (reasoning effort)" via PR #2. Empirically verified live on `wangfu/Qwen3.6-35B-A3B-oQ4-mtp`
off/on (see "Empirical" notes below). Companion to the "Thinking Level (Reasoning Effort)"
section in `docs/src/content/docs/en/configuration/routing.md` (which documents the current
model-only behavior).

**Goal:** let a Claude-Code-originated subagent/Task/Workflow request set a thinking (reasoning
effort) level per spawn, in prompt text, with the same mechanics as the existing
`<CCR-SUBAGENT-MODEL>` tag: unconditional extraction, strip-before-forward, fail-open.

## 1. Non-Goals (v1)

- No UI surface (Routing page, Models page) for thinking presets.
- No per-message granularity — one level per request.
- No token budgets (`budget_tokens`, `thinking_budget`) — levels only.
- No Codex built-in route — Claude Code route only (mirrors the model tag).
- No Fusion/gateway-kind targets (`RouteModelRef` kind `"gateway"`): fail-open + diagnostic.
- No change to the toolhub planner (separate system, fixed request body).

## 2. Tag Protocol

```text
<CCR-SUBAGENT-THINKING>off</CCR-SUBAGENT-THINKING>
```

- **Value domain (closed set):** `on | off | low | medium | high` — trimmed, case-insensitive.
  Anything else (including a literal placeholder or empty) → tag ignored, diagnostic emitted.
- **Placement:** same surfaces as the model tag — system prompt (text or content block) or the
  first two user messages. First occurrence wins. Order relative to the model tag is irrelevant.
- **Stripping:** the tag is removed from the prompt before forwarding, **even when the value is
  invalid or the target is unmapped** — the marker must never leak upstream.
- **Independence:** works with, without, and against a model tag:
  - thinking-only → applies to whatever model the request would resolve to;
  - model-only → unchanged behavior;
  - both → model tag picks the model, thinking tag rewrites the body for that model's protocol.
- **Precedence:** overrides client-provided thinking fields in the request body (set = replace).
  Custom routing-rule rewrites applied after the built-in decision win on the same key
  (`mergeConfiguredRouteDecisions` concatenates `[...base.rewrites, ...rule.rewrites]`).

## 3. Value → Body Mapping (keyed by resolved provider protocol)

| Value | `openai_chat_completions` (DeepSeek, local backends) | `anthropic` | `openai_responses` |
| --- | --- | --- | --- |
| `off` | `enable_thinking: false` | `thinking: {type: "disabled"}` (+ strip client `output_config`) | **qwen-family: `enable_thinking: false`** (verified 2026-09-03); genuine OpenAI Responses backends (none in fleet): `reasoning: {effort: "minimal"}` |
| `on` | `enable_thinking: true` | no rewrite (client default) | **qwen-family: `enable_thinking: true`**; Responses backends: no rewrite |
| `low`/`medium`/`high` | `enable_thinking: true` (lossy; provider-override table later) | `output_config: {effort: …}` (verify current API shape) | **qwen-family: `enable_thinking: true`** (lossy); Responses backends: `reasoning: {effort: …}` |

> **Fleet correction (2026-09-03):** the `openai_responses` column must NOT default to
> `reasoning.effort`. wangfu/qwen models are typed `openai_responses` but are oMLX chat backends
> that honor `enable_thinking` (verified: `enable_thinking:false` suppresses qwen3.8 thinking ~7×;
> `enable_thinking:true` enables it) — they do **not** support `reasoning.effort`. So the mapping
> needs a per-provider override row (qwen/openai-responses → `enable_thinking`), not pure
> per-protocol keying.

Rules:

- Mapping is a small table in the plugin file: `protocol × value → RouterRuleRewrite[]`.
- Rewrite values stay strings in the decision; `parseRewriteLiteral` (`routing/rewrite.ts`)
  converts `"false"` → boolean at apply time (verified).
- Unmapped protocol/model kind, or protocol whose upstream would 400 on the field → no rewrite,
  diagnostic. Note (updated 2026-09-03): `upstream/executor.ts`
  `stripUnsupportedOpenAiRequestParameters` no longer just drops Anthropic-shaped
  `thinking`/`reasoning_split` for openai_chat/openai_responses upstreams — it now **maps** a
  present thinking intent to `enable_thinking` (`f663770`/`d6b4737`, live on the Emmy gateway), so
  any client sending a raw thinking field to an openai-path provider gets it translated. The tag
  path is complementary: when a thinking tag resolves, the rewrite must **strip the client's
  `thinking`/`enable_thinking` fields and set** `enable_thinking` (openai) / `thinking` (anthropic)
  — one consistent shape, no double-handling with the executor.
- Optional capability gate (P2): `model-discovery.ts` computes `supportsReasoning` from the
  catalog; if exposed on `RouteModelRef`, use it to skip rewrites for non-reasoning models.
  v1 does not depend on this.

## 4. Integration Points (all source-verified against current checkout)

| # | File | Change |
| --- | --- | --- |
| 1 | `packages/core/src/routing/contracts.ts` (~L56) | Add `builtInSubagentThinking?: string` to `RouteRequest`, beside `builtInSubagentModel`. |
| 2 | `packages/core/src/routing/route-script-context.ts` (~L9, L38) | Mirror the field into script-rule `input` (`input.builtInSubagentThinking`). |
| 3 | `packages/core/src/gateway/claude-code-router-plugin.ts` L714–717 | Add `ccrSubagentThinkingOpenTag`/`CloseTag`/placeholder constants (naming parallel to the model tag). |
| 4 | same, enricher L80–84 | `matchedRequest.builtInSubagentThinking = extractAndRemoveClaudeCodeSubagentThinkingTag(matchedRequest.body);` — runs unconditionally for every claude-code-matched request, exactly like the model tag. |
| 5 | same, L1061–1152+ | New `extractAndRemoveClaudeCodeSubagentThinkingTag(body)` reusing the existing traversal (`FromSystem` / `FromMessage` / `FromContentBlock` / `FromText`); generalize the shared text helper to accept a tag pair, or add a parallel helper — implementation detail, either keeps both tags stripped in one pass. |
| 6 | same, `resolveBuiltInClaudeCodeSubagentRouteDecision` (~L471) | Replace hardcoded `rewrites: []` with `buildSubagentThinkingRewrites(request, configuredTarget)` when a model tag resolved. |
| 7 | same, **thinking-only path (design decision D1)** | When only the thinking tag is present, the model-tag decision returns `undefined`, so the rewrite must be produced elsewhere. Recommended: standalone pass after `configuredDecision` resolves in `routeRequest` (~L140), keyed on `request.builtInSubagentThinking` + the finally selected model's provider protocol (`RouteModelRef` provider variant exposes `.provider`); applied through the same `applyCompiledRouteRewrite` loop with `customer.rewrite:*` trace capture. Alternative: extend the decision function to emit a model-less decision — rejected, muddies decision semantics. |
| 8 | same, L719–736 (P1 only) | Optionally extend the injected Agent/Task/Workflow instruction templates (EN + 中文) with the value list; gated by the same Description non-empty condition. v1 ships manual-only. |
| 9 | `packages/core/src/routing/contracts.ts` `RouteDiagnosticCode` | Add code(s), e.g. `subagent-thinking-unmapped` / `subagent-thinking-unsupported-target`. |

No config-schema migration, no `config.sqlite` change, no UI change.

## 5. Open Design Decisions

- **D1 (application site):** standalone post-decision pass (recommended, item 7) vs decision-carried rewrites only. Standalone pass is required for the thinking-only case either way; using it for the combined case too keeps one code path.
- **D2 (value domain):** `on|off|low|medium|high` as specced. Fleet note: local OpenAI-compatible backends are binary, so `low/medium/high` collapse to `enable_thinking: true` in v1 — acceptable, lossy-but-honest.
- **D3 (injection, P1):** ship without touching the injected instructions (extraction is unconditional, so manual/script-written tags work immediately). Recommend yes for v1 = no injection.

## 6. Diagnostics & Observability

- Emit `RouteDiagnostic` for: invalid value, unmapped protocol/target, gateway-kind target.
- Rewrite application already emits `customer.rewrite:set:<key>` trace mutations — reused as-is.
- Request logs (`request_logs`) unchanged in shape; the final upstream body carries the field.

## 7. Test Plan

Unit — extend `packages/core/test/unit/gateway/router-builtins.test.mjs` (existing subagent
suite: cases at L1629, L2086, L2140, L2266, L2400+):

1. Extraction: system text / system content block / user msg 1 / user msg 2; third user message
   NOT scanned; both tags in one prompt (any order); first occurrence wins.
2. Stripping: tag removed in all cases above, valid or invalid value, thinking-only or paired.
3. Normalization: case/trim; invalid → ignored + diagnostic; placeholder → ignored.
4. Mapping: `openai_chat_completions` off/on; `anthropic` off/medium; unmapped protocol → no
   rewrite + diagnostic; gateway-kind target → no rewrite + diagnostic.
5. Combined: model tag + thinking tag → `body.model` replaced AND thinking field set; thinking
   only → model untouched, thinking field set; custom rule rewrite on same key → rule wins.
6. Client-body override: pre-set `enable_thinking` in the request body is replaced by the tag.

Empirical (mirrors the 2026-08-04 three-test validation, via `request-logs.sqlite`):

- Tagged spawn to **qwen** (`wangfu/Qwen3.6-35B-A3B-oQ4-mtp` or `Qwen3.8-27B-MLX-oQ4e-mtp`) with
  `off` → thinking suppressed / no reasoning; with `on` → reasoning present. (qwen honors
  `enable_thinking`, verified 2026-09-03.)
- **NOT DeepSeek for this check:** DeepSeek accepts-but-ignores `enable_thinking:false` and still
  emits `reasoning_content` (verified 2026-09-03) — its reasoning needs a different lever, so it
  cannot validate on/off via the enable_thinking path.
- Upstream body inspection via a local echo provider or provider-side logging.

## 8. Phasing

| Phase | Contents | Estimate |
| --- | --- | --- |
| P0 (core) | Items 1–7, 9 + unit tests 1–6 | ~150–250 LOC source, ~350 LOC tests; 1–2 focused sessions |
| P1 (docs + injection) | routing.md flip "Planned → Implemented" (value table, D2/D3 outcomes), optional item 8, `ccr-documentation.org` pointer, empirical tests | small |
| P2 (optional) | capability gate via `supportsReasoning`; provider-override table for token budgets; UI preset | deferred |

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream 400 on unknown parameter | Protocol-keyed mapping table; fail-open + diagnostic; verify field names per provider before shipping P0 (DeepSeek `enable_thinking` already verified honored). |
| Tag leaks upstream on exotic content shapes | Extraction runs on all text surfaces; stripping is unconditional; unit test 2 covers mixed blocks. |
| Rule-rewrite precedence surprises | Merge order is base-then-rule (verified in `mergeConfiguredRouteDecisions`); document in routing.md. |
| Scope creep into budgets/UI | Non-goals section is the contract for v1. |
