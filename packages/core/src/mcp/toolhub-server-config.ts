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

import { LEGACY_PROTOCOL_VERSION, resolveProtocolEra } from "@ccr/core/mcp/protocol-era";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type GatewayMcpServerBaseConfig = {
  label?: string;
  name: string;
  protocolEra?: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  transport: "stdio" | "streamable-http" | "sse";
};

type GatewayMcpStdioServerConfig = GatewayMcpServerBaseConfig & {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdioMessageMode?: "content-length" | "newline-json";
  transport: "stdio";
};

type GatewayMcpRemoteServerConfig = GatewayMcpServerBaseConfig & {
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  transport: "streamable-http" | "sse";
  url: string;
};

export type NormalizedServerConfig = GatewayMcpStdioServerConfig | GatewayMcpRemoteServerConfig;

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
