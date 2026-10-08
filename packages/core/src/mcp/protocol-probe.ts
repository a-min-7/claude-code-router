// ──────────────────────────────────────────────────────────────────────────────
// Protocol-era probe for remote MCP servers.
//
// Mirrors `pi-mcp-adapter`'s mcp-probe.ts so CCR can discover the era a server
// supports without sending a modern request that might break a working legacy
// connection.
//
// Strategy:
// 1. POST `server/discover` to the server URL.
//    If the server responds with JSON-RPC 2.0 and
//    `supportedVersions` includes `"2026-07-28"`, return `"2026-07-28"`.
// 2. If `server/discover` is not understood, POST the legacy `initialize`
//    handshake and return `"legacy"`.
// 3. If neither works, return `"legacy"` — never guess upward.
// ──────────────────────────────────────────────────────────────────────────────

import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./protocol-era";

const PROBE_TIMEOUT_MS = 5_000;
const MODERN_FALLBACK_STATUSES = new Set([400, 401, 404, 405, 406, 415]);

/** Result of probing a server's protocol era. */
export interface ProtocolProbeResult {
  era: "legacy" | "2026-07-28";
  /** Human-readable reason. */
  detail: string;
}

const DISCOVER_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "server/discover",
  params: {},
};

const INITALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "CCR", version: "3.1.0" },
  },
};

async function jsonRpcEnvelopeInfo(value: unknown): Promise<{
  kind: "result";
  /** The `supportedVersions` array from a `server/discover` response, or `undefined`. */
  supportedVersions: unknown[] | undefined;
  /** The `protocolVersion` from a legacy `initialize` response, or `undefined`. */
  protocolVersion: unknown;
} | { kind: "error" } | null> {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") return null;
  if ("result" in obj) {
    const result = obj.result as Record<string, unknown> | undefined;
    if (typeof result !== "object" || result === null) {
      return { kind: "result" as const, supportedVersions: undefined, protocolVersion: undefined };
    }
    return {
      kind: "result" as const,
      supportedVersions: Array.isArray(result.supportedVersions) ? result.supportedVersions : undefined,
      protocolVersion: result.protocolVersion,
    };
  }
  if ("error" in obj) return { kind: "error" as const };
  return null;
}

/**
 * Probe a remote (HTTP / SSE) MCP server to discover what protocol era it
 * supports.
 *
 * Safe to call against a legacy server: probing never breaks a working
 * connection.  If the era cannot be determined, returns `"legacy"`.
 *
 * @param url — the server's HTTP endpoint (e.g. `http://localhost:3456/__ccr/toolhub/mcp`)
 * @param options — optional configuration
 * @returns the best-effort era verdict
 */
export async function probeProtocolEra(
  url: string | URL,
  options?: { timeoutMs?: number },
): Promise<ProtocolProbeResult> {
  const timeout = options?.timeoutMs ?? PROBE_TIMEOUT_MS;

  // Phase 1: modern `server/discover` probe.
  try {
    const discoverResponse = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      },
      body: JSON.stringify(DISCOVER_REQUEST),
      signal: AbortSignal.timeout(timeout),
    });

    // Parse the response body directly — no second fetch needed.
    if (discoverResponse.ok) {
      const body = await discoverResponse.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(body);
      } catch {
        // Non-JSON response (likely SSE for legacy) — fall through to legacy.
        envelope = null;
      }
      const info = await jsonRpcEnvelopeInfo(envelope);
      if (info && info.kind === "result" && Array.isArray(info.supportedVersions) && info.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
        return { era: "2026-07-28", detail: "server advertised stateless protocol 2026-07-28" };
      }
      // Server responded OK but did not advertise modern — treat as legacy.
      return { era: "legacy", detail: "server accepted legacy but did not advertise modern" };
    }

    // Phase 2: fall back to legacy `initialize` if the server declined
    // `server/discover` with a recoverable status.
    if (!MODERN_FALLBACK_STATUSES.has(discoverResponse.status)) {
      return { era: "legacy", detail: `server declined discover with HTTP ${discoverResponse.status}` };
    }

    const initResponse = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(INITALIZE_REQUEST),
      signal: AbortSignal.timeout(timeout),
    });

    if (initResponse.ok) {
      const body = await initResponse.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(body);
      } catch {
        envelope = null;
      }
      const info = await jsonRpcEnvelopeInfo(envelope);
      if (info && info.kind === "result") {
        return { era: "legacy", detail: "legacy initialize handshake succeeded" };
      }
    }

    return { era: "legacy", detail: `probe inconclusive: discover=${discoverResponse.status} init=${initResponse.status}` };
  } catch (err) {
    return { era: "legacy", detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Simple in-memory cache for probe results. */
export class ProtocolEraCache {
  private entries = new Map<string, { era: "legacy" | "2026-07-28"; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 60_000) {}

  get(url: string): "legacy" | "2026-07-28" | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(url);
      return undefined;
    }
    return entry.era;
  }

  set(url: string, era: "legacy" | "2026-07-28"): void {
    this.entries.set(url, { era, expiresAt: Date.now() + this.ttlMs });
  }

  /** Invalidate all cached entries — call on connection failure. */
  invalidate(): void {
    this.entries.clear();
  }
}
