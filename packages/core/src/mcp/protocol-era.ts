// ──────────────────────────────────────────────────────────────────────────────
// Protocol era vocabulary for per-server MCP negotiation.
//
// Three-value, defaulting to `"legacy"` so that merging this work changes
// nothing until someone opts in.  The wire header for the legacy era is
// `"2024-11-05"` — that is the *value on the wire*, not the config
// vocabulary (which is `"legacy"`).
//
// `auto` and `"2026-07-28"` are stored per-server and consumed by P3
// (the modern-era branch in the three hand-rolled clients:
//  StdioMcpClient, SseMcpClient, HttpMcpClient).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Protocol era vocabulary — mirrors `pi-mcp-adapter` so the two configs read
 * identically.  Existing configs that say `"2024-11-05"` are accepted as
 * input and normalised to `"legacy"` so they keep working unchanged.
 *
 * - `"legacy"` — default; today's behaviour, byte-identical.
 * - `"auto"`   — P2 probe returns `"legacy"` or `"2026-07-28"` from the
 *                  advertised `supportedVersions`; cached per server with a
 *                  TTL, invalidated on connection failure.
 * - `"2026-07-28"` — pin modern; fail loudly if the server cannot.
 */
export type McpProtocolEra = "legacy" | "auto" | "2026-07-28";

/** The wire-level protocol version string for the legacy era. */
export const LEGACY_PROTOCOL_VERSION = "2024-11-05";

/** The modern (stateless) protocol version. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Resolve an incoming config value to the internal protocol-era vocabulary.
 *
 * Normalisation rules:
 * - `undefined` → `"legacy"` (the default)
 * - `"2024-11-05"` → `"legacy"` (backward-compatible literal accepted)
 * - `"legacy"` → `"legacy"` (identity)
 * - `"auto"` → `"auto"`
 * - `"2026-07-28"` → `"2026-07-28"`
 * - anything else → `"legacy"` (fail-open on the safe default)
 *
 * Existing configs that still say `"2024-11-05"` keep working because this
 * function treats that string as an alias for `"legacy"`.
 */
export function resolveProtocolEra(value: string | undefined): McpProtocolEra {
  if (!value) return "legacy";
  switch (value) {
    case "2024-11-05":
    case "legacy":
      return "legacy";
    case "auto":
      return "auto";
    case "2026-07-28":
      return "2026-07-28";
    default:
      return "legacy";
  }
}

/**
 * Convert a normalised internal era to the value that goes on the wire
 * as the `MCP-Protocol-Version` HTTP header.
 *
 * For `"legacy"` the wire value is `"2024-11-05"`.  `auto` and
 * `"2026-07-28"` are not yet wired (P3).
 */
/**
 * Convert a config-value (plain string) to the wire-level header value.
 *
 * Calls the normalizer so callers never need to.  This is the bridge
 * between the config surface (`string`) and the wire (`"2024-11-05"`
 * for legacy, `"2026-07-28"` for modern-era opts-in).
 */
export function resolveWireProtocolVersion(era: string): string {
  const normalised = resolveProtocolEra(era);
  switch (normalised) {
    case "legacy":
      return LEGACY_PROTOCOL_VERSION;
    case "auto":
    case "2026-07-28":
      return MODERN_PROTOCOL_VERSION;
  }
}
