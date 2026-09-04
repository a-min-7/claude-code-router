// GLM-5.3 / GLM-5.3-FLASH are forced-thinking models (Z.ai rejects
// enable_thinking:false with 400 code 1210 — "This model always engages in
// thinking and cannot be disabled; please use low, high, or max").
// Used by the ToolHub resolver (toolhub-mcp.ts) and the gateway executor
// (executor.ts normalizeZaiGlm53ReasoningEffort) to switch from disable-thinking
// to reasoning_effort:"low" for these models.
// Z.AI docs: https://docs.z.ai/guides/llm/glm-5.3 + /guides/capabilities/thinking.md

export const ZAI_FORCED_THINKING_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

export function isZaiForcedThinkingModel(model: string | undefined): boolean {
  return Boolean(model && ZAI_FORCED_THINKING_MODELS.has(model.trim().toLowerCase()));
}
