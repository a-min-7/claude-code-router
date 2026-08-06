---
title: Built-In Vision
pageTitle: Built-In Vision
eyebrow: Fusion
lead: Give a non-multimodal model visual ability, for example GLM-5.2 + GLM-5V-Turbo = GLM-5.2V.
---

## Capability Composition

Built-in Vision connects a vision model in front of the base model without replacing the text model you already trust. The vision model understands images, screenshots, charts, and OCR content; CCR passes that visual result to the base model, which continues to handle reasoning, writing, coding, and final output.

The combined Fusion model can be selected by routing or Agent Profiles like any other model. A typical form is:

```text
GLM-5.2 + GLM-5V-Turbo = GLM-5.2V
```

This keeps the familiar text model while adding visual input support, so a non-multimodal model can still work with image context.

This also applies to Codex computer use. After combining GLM-5.2 with GLM-5V-Turbo, GLM-5.2 can receive screen, screenshot, and UI information prepared by the vision model, then use Codex computer use for observation, judgment, and follow-up action planning.

## Select The Capability

Select `ccr-fusion-builtins / vision_understand`, and choose a Vision model that actually supports image understanding.

## Model Requirement

The Vision model determines image, screenshot, chart, and OCR understanding quality. The base model determines the final answer style, reasoning ability, and coding ability.

## Troubleshooting

When image requests fail, relevant details include whether the Vision model supports visual input and any Fusion tool errors in Logs.

---

> **Fork contribution (Armin Monecke, 2026-08-06).** The upstream docs do not
> cover the following failure modes. They were root-caused against the running
> gateway (`@the-next-ai/ai-gateway`), not the UI.

### Why the vision tool may not be called even though the profile is configured correctly

The Fusion vision tool is injected into the base model's request (verified: the
model's own reasoning references `vision_understand` and the `[media_ref:...]`
value), so a misconfigured profile is usually *not* the cause. Two observed
failure modes:

1. **A reasoning base model that can read the image itself will short-circuit
   the tool.** A multimodal-adjacent base model (e.g. Nemotron-3-Super served
   through Grace/vLLM, which OCRs an inline image internally) extracts the text
   directly and answers without ever emitting a `tool_use` — so the vision model
   is never invoked. This is a model-behavior limitation, not a wiring one.
   `request_logs` will show a single call to the base provider and **no** call
   to the vision provider. The explicit tool instruction added by this fork
   (see below) makes the intended call unambiguous, but it cannot force a base
   model that already has the answer to delegate.

2. **Non-streaming requests with internal tools deadlock.** A non-streaming
   request to a Fusion profile that has internal tools can time out (499 in
   `request_logs`, "Client connection closed before response completed") because
   the nested vision sub-call cannot be served while the non-streaming request
   is buffered. Use streaming (Claude Code always streams) or a client that
   streams.

### Fork-added explicit instruction

This fork appends an explicit instruction to Fusion profiles that declare a
vision tool: when the model input contains a `[media_ref:...]` value under
"Multimodal inputs available to tools", call the vision tool with `imageBase64`
set to that value, and do not answer image questions from the model's own
reading. It makes the handoff concrete for models that do delegate; it does not
override a model that chooses to answer directly.
