// GLM-5.3 / GLM-5.3-FLASH are forced-thinking models (Z.ai rejects
// enable_thinking:false with 400 code 1210 — "This model always engages in
// thinking and cannot be disabled; please use low, high, or max").
// Used by the ToolHub resolver (toolhub-mcp.ts) and the gateway executor
// (executor.ts normalizeZaiGlm53ReasoningEffort) to switch from disable-thinking
// to reasoning_effort:"low" for these models.
// Z.AI docs: https://docs.z.ai/guides/llm/glm-5.3 + /guides/capabilities/thinking.md

export const ZAI_FORCED_THINKING_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

// CCR addresses models as "<Provider>/<model>" — e.g. the resolver's configured
// TOOLHUB_OPENAI_MODEL is "Z.ai (Global) - General Endpoint/glm-5.3-flash", and the
// gateway's executor falls back to the raw body.model (same prefixed form) whenever
// no modelSelector resolves.
//
// Matching the raw string against bare ids therefore missed EVERY CCR-prefixed name,
// which silently turned this guard into a no-op: the resolver kept sending
// enable_thinking:false and Z.ai answered 400 code 1210 on every resolve, while the
// gateway clamp declined to repair it on its fallback path. Compare the last path
// segment so both the bare id and the prefixed form match.
export function normalizeZaiModelId(model: string | undefined): string {
  if (!model) {
    return "";
  }
  const segments = model.trim().toLowerCase().split("/");
  return (segments[segments.length - 1] ?? "").trim();
}

export function isZaiForcedThinkingModel(model: string | undefined): boolean {
  return ZAI_FORCED_THINKING_MODELS.has(normalizeZaiModelId(model));
}
