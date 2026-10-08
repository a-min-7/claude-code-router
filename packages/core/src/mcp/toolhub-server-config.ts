// ──────────────────────────────────────────────────────────────────────────────
// Backend MCP server config normalisation for the toolhub resolver.
//
// Extracted from `toolhub-mcp.ts`, which wires `process.stdin` at module scope
// (`:227-245`) and therefore cannot be imported by a unit test without resuming
// the test runner's stdin and hanging it. This module is pure and importable.
//
// ⚠️ THE ERA SEAM LIVES HERE. Two vocabularies meet in this file and nowhere else:
//
//   - the CONFIG surface names the field `protocolVersion`
//     (`contracts/app.ts` `GatewayMcpServerBaseConfig`, `config/config.ts`
//     `parseMcpServers`, the settings UI, and the `TOOLHUB_MCP_SERVERS_JSON`
//     the gateway hands the resolver);
//   - the SDK ADAPTERS read `protocolEra`
//     (`toolhub-sdk-adapters.ts` — `resolveProtocolEra(this.server.protocolEra)`).
//
// Nothing else maps one to the other. When this mapping is missing, every server
// silently resolves to `"legacy"`, the era config appears to have no effect, and
// the failure reads as "the config didn't take" — pointing at the wrong thing.
// `toolhub-era-seam.test.mjs` drives the real `TOOLHUB_MCP_SERVERS_JSON` shape
// through here into an adapter to keep that from recurring.
// ──────────────────────────────────────────────────────────────────────────────

import { LEGACY_PROTOCOL_VERSION, resolveProtocolEra, type McpProtocolEra } from "@ccr/core/mcp/protocol-era";
import type {
  GatewayMcpRemoteServerConfig as ContractRemoteServerConfig,
  GatewayMcpServerConfig as ContractServerConfig,
  GatewayMcpStdioServerConfig as ContractStdioServerConfig
} from "@ccr/core/contracts/app";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** The two fields the resolver's internals add on top of the config contract. */
type ResolverInternalFields = {
  /** Presentational only; the config contract does not model it. */
  label?: string;
  /** The resolver's internal era vocabulary, resolved from `protocolVersion`. */
  protocolEra?: McpProtocolEra;
};

/**
 * The resolver's internal server shape: the **config contract**, plus the two
 * fields only the resolver's internals carry.
 *
 * ⚠️ Derived from the contract deliberately. This shape used to be declared
 * independently in **four** files — the contract, plus hand-kept mirrors in
 * `toolhub-mcp.ts`, `toolhub-sdk-adapters.ts` and this module — and **none of
 * them imported the contract**. That four-fold duplication is what let
 * `protocolVersion` (the config surface's name) and `protocolEra` (the adapters'
 * name) drift apart unnoticed: both sides compiled, every server resolved to
 * `"legacy"`, and a green ~79-test era suite certified a feature that never
 * reached the wire.
 *
 * Deriving from the contract means a rename or an added field there now breaks
 * the consumer at **compile time** instead of silently at runtime. Do not
 * re-declare this shape locally — import one of the three below.
 */
export type NormalizedRemoteServerConfig = ContractRemoteServerConfig & ResolverInternalFields;
export type NormalizedStdioServerConfig = ContractStdioServerConfig & ResolverInternalFields;
export type NormalizedServerConfig = ContractServerConfig & ResolverInternalFields;

export function normalizeServerConfig(value: unknown): NormalizedServerConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawTransport = typeof value.transport === "string" ? value.transport : typeof value.type === "string" ? value.type : "";
  const normalizedTransport = rawTransport.toLowerCase().replace(/_/g, "-");
  const transport = normalizedTransport === "streamable-http" || normalizedTransport === "streamablehttp" || normalizedTransport === "http"
    ? "streamable-http"
    : normalizedTransport === "sse"
      ? "sse"
      : "stdio";
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const base = {
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
    name,
    // The config surface says `protocolVersion`; the adapters read `protocolEra`.
    // Normalising here is what closes the seam — see the header note.
    protocolEra: resolveProtocolEra(typeof value.protocolVersion === "string" ? value.protocolVersion : undefined),
    protocolVersion: typeof value.protocolVersion === "string" ? value.protocolVersion : LEGACY_PROTOCOL_VERSION,
    requestTimeoutMs: normalizeTimeout(value.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    startupTimeoutMs: normalizeTimeout(value.startupTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    transport
  };
  if (transport !== "stdio") {
    const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : "";
    if (!url) {
      return undefined;
    }
    return {
      ...base,
      apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
      apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : undefined,
      headers: isStringRecord(value.headers) ? value.headers : {},
      transport,
      url
    };
  }
  const command = typeof value.command === "string" && value.command.trim() ? value.command.trim() : "";
  if (!command) {
    return undefined;
  }
  return {
    ...base,
    args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [],
    command,
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined,
    env: isStringRecord(value.env) ? value.env : {},
    stdioMessageMode: value.stdioMessageMode === "newline-json" ? "newline-json" : "content-length",
    transport
  };
}

function normalizeTimeout(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 100), 600_000) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
