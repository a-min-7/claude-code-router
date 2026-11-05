/**
 * SDK-backed transport adapters for the ToolHub MCP clients.
 *
 * These adapters replace the hand-written transport implementations in
 * toolhub-mcp.ts with thin wrappers around the official MCP SDK 2.x
 * transports (`@modelcontextprotocol/client`). The existing client
 * classes keep their internal state and method signatures so callers,
 * session handling and routing do not move.
 *
 * Each adapter wraps the SDK's transport in the `Client` class and
 * exposes the same three-method `McpClient` interface:
 * `listTools()`, `callTool()`, `close()`.
 */

import {
  Client as SdkClient,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type PriorDiscovery,
  type VersionNegotiationOptions
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MODERN_PROTOCOL_VERSION } from "@ccr/core/mcp/protocol-era";
import { resolveProtocolEra, toolHubClientCapabilities } from "@ccr/core/mcp/protocol-era";
import type { McpProtocolEra } from "@ccr/core/mcp/protocol-era";
import { ProtocolEraCache } from "@ccr/core/mcp/protocol-probe";
import { isSessionLossError, toTypedTransportError } from "@ccr/core/mcp/toolhub-mcp-session";
import { attachToolHubTaskRuntime, type ToolHubTaskRuntime } from "@ccr/core/mcp/toolhub-tasks";
import type {
  NormalizedRemoteServerConfig,
  NormalizedStdioServerConfig
} from "@ccr/core/mcp/toolhub-server-config";

// ── Type mirrors of toolhub-mcp.ts server config types ──────────────

type McpClient = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  listTools(): Promise<ToolDefinition[]>;
};

type ToolDefinition = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
  title?: string;
};

// ⚠️ Do NOT re-declare the server shape here. It is derived from the config
// contract in `toolhub-server-config.ts`. A hand-kept mirror in this file is what
// let `protocolVersion` (the config's name) and `protocolEra` (the name read
// below) diverge with nothing failing — both sides compiled, every server
// resolved to "legacy", and a green ~79-test era suite certified it. Fixed
// 2026-10-08, fork 5d1b4663.
type GatewayMcpRemoteServerConfig = NormalizedRemoteServerConfig;
type GatewayMcpStdioServerConfig = NormalizedStdioServerConfig;

// ── Shared constants ────────────────────────────────────────────────

const TOOLHUB_NAME = "ccr-toolhub";

/**
 * A stable fingerprint of what the server currently claims in its `extensions`
 * map — the same field `serverAdvertisesTasks` reads (issue #31).
 *
 * The task runtime used to be resolved once per *client instance*, so a backend
 * that connected while it did not advertise kept that answer for the life of the
 * connection: measured 2026-11-05, four toolhubs returned `Unsupported result
 * type 'task'` for a server that had started advertising, and only replacing the
 * process cleared it. Keying the negative cache on the claim as well as the
 * client costs one local accessor read per tool call and re-probes when the
 * claim changes.
 *
 * Never throws: a capability read that fails reads as "unchanged", which
 * degrades to the previous behaviour rather than breaking the plain path.
 */
function taskRuntimeCapabilityFingerprint(client: SdkClient): string {
  try {
    return JSON.stringify(client.getServerCapabilities()?.extensions ?? null);
  } catch {
    return "";
  }
}

/**
 * Whether a `tools/call` rejection is the SDK refusing a result it cannot decode
 * because the server answered with a task handle (issue #31).
 *
 * Matched on the message rather than a code because the rejection comes from the
 * SDK's result decoder, not from an error we construct. Kept narrow — "task" AND
 * "Unsupported result type" — so an unrelated failure is never mistaken for the
 * one case a retry can repair.
 */
function isUnsupportedResultTypeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported result type/i.test(message) && /task/i.test(message);
}

// ─── SSE adapter ────────────────────────────────────────────────────
/**
 * Wraps the SDK's SSEClientTransport. The SDK (2.3.1) deprecates this
 * type, but the deprecation note says: "Prefer to use
 * StreamableHTTPClientTransport where possible ... because some servers
 * are still using SSE, clients may need to support BOTH transports
 * during the migration period." CCR has configured SSE servers, so we
 * restore it here with the deprecation suppressed.
 */

class SseMcpSdkAdapter implements McpClient {
  private sdkTransport: SSEClientTransport | undefined;
  private sdkClient: SdkClient | undefined;
  private connected = false;
  private initialized = false;
  private era: McpProtocolEra = "legacy";
  private recovery: Promise<void> | undefined;
  /** Present only when this server advertises the Tasks extension — see toolhub-tasks.ts. */
  private taskRuntime: ToolHubTaskRuntime | undefined;
  /** The client the runtime above is attached to; a new client invalidates it. */
  private taskRuntimeClient: SdkClient | undefined;
  /** The advertised capabilities seen when that runtime was resolved (issue #31). */
  private taskRuntimeCapabilities: string | undefined;
  private static readonly probeCache = new ProtocolEraCache(60_000);

  constructor(
    private readonly server: GatewayMcpRemoteServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {
    this.era = resolveProtocolEra(this.server.protocolEra);
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.listTools();
      return this.normalizeToolList(result);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let taskBacked = false;
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      await this.resolveTaskRuntime();
      if (this.taskRuntime) {
        // The server may answer with a task handle, which the SDK's own callTool
        // cannot even parse — see toolhub-tasks.ts.
        taskBacked = true;
        return this.taskRuntime.execute(name, args, this.server.requestTimeoutMs);
      }
      // ⚠️ Pass the configured timeout explicitly. Without it the SDK falls back to
      // DEFAULT_REQUEST_TIMEOUT_MSEC (60 s), silently discarding the per-server
      // `requestTimeoutMs` the config surface carries — the pre-SDK hand-rolled client
      // used it as the default for every request. Measured 2026-10-09: a 65 s tool call
      // was rejected at 60.0 s against a server configured for 120 s.
      let result;
      try {
        result = await this.sdkClient!.callTool({ name, arguments: args }, { timeout: this.server.requestTimeoutMs });
      } catch (error) {
        if (!isUnsupportedResultTypeError(error)) {
          throw error;
        }
        // ⚠️ Issue #31. The server answered `tools/call` with a task while this
        // connection carried no runtime. The declared capabilities are captured
        // at `initialize` and never refresh on a live connection, so this
        // failure is the only reliable signal that the server now offers tasks:
        // drop the cached answer, resolve again, and retry ONCE through the
        // runtime. If the retry cannot attach, the original error surfaces.
        this.taskRuntimeClient = undefined;
        this.taskRuntimeCapabilities = undefined;
        // ⚠️ Clearing the markers is not enough: `attachToolHubTaskRuntime` reads
        // the capabilities the client captured at `initialize`, and those are
        // just as stale as the cache. Rebuild the connection so the handshake
        // re-reads what the server actually offers, then attach against that.
        await this.reinitializeAfterSessionLoss();
        const retryRuntime = await this.resolveTaskRuntime();
        if (!retryRuntime) {
          throw error;
        }
        taskBacked = true;
        return retryRuntime.execute(name, args, this.server.requestTimeoutMs);
      }
      if ((result as Record<string, unknown>).isError === true) {
        const isErrorResult = result as Record<string, unknown>;
        throw new Error(
          `Tool ${name} failed: ${JSON.stringify(isErrorResult.content ?? "no content")}`
        );
      }
      return result;
    }, () => !taskBacked);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.connected = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
  }

  /** Build the prior-discovery value for this server's era. */
  private priorDiscovery(): PriorDiscovery {
    const era = this.era;
    if (era === "legacy") {
      return { kind: "legacy" as const };
    }
    if (era === "auto") {
      const cached = SseMcpSdkAdapter.probeCache.get(this.server.url);
      if (cached === "legacy") return { kind: "legacy" as const };
      return {
        kind: "modern" as const,
        discover: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} }
        }
      } as unknown as PriorDiscovery;
    }
    // era === "2026-07-28" (pinned modern)
    return {
      kind: "modern" as const,
      discover: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: {} }
      }
    } as unknown as PriorDiscovery;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.sdkClient) {
      // SSEClientTransport is deprecated in 2.3.1; the SDK says
      // "prefer StreamableHTTPClientTransport where possible" and
      // "because some servers are still using SSE, clients may need
      // to support BOTH transports during the migration period."
      // CCR has configured SSE servers, so we restore it with the
      // deprecation suppressed here. The SSE path is the legacy path
      // for rmcp servers that have not been upgraded to streamable-HTTP.
      const sdkTransport = new SSEClientTransport(new URL(this.server.url), {
        requestInit: {
          headers: this.server.headers ?? {}
        }
      });
      this.sdkTransport = sdkTransport;
      this.sdkClient = new SdkClient(
        { name: TOOLHUB_NAME, version: "1.0.0" },
        {
          capabilities: toolHubClientCapabilities(),
          ...versionNegotiationForEra(this.era)
        }
      );
    }
    if (!this.connected) {
      const transport = this.sdkTransport!;
      if (this.era === "legacy") {
        // Legacy era: skip auto-probe, run the plain legacy handshake.
        // The SDK's _connectPlainLegacy handles initialize + notification.
        await this.sdkClient.connect(transport, { prior: this.priorDiscovery() });
      } else if (this.era === "auto") {
        // Auto era: let SDK probe (default connect behavior).
        // The SDK probes server/discover and falls back to legacy initialize.
        await this.sdkClient.connect(transport);
      } else {
        // Pinned modern: let the SDK probe, so it learns the server's REAL
        // DiscoverResult. See versionNegotiationForEra.
        await this.sdkClient.connect(transport);
      }
      this.connected = true;
    }
    this.initialized = true;
  }

  private async withSessionRecovery<T>(
    operation: () => Promise<T>,
    /**
     * ⚠️ A task-backed call must never be replayed. The retry re-issues
     * `tools/call`, and a task-producing server answers it by creating a SECOND
     * task upstream — while the first keeps running with nobody polling it. Both
     * bill. Unreachable on today's config (tasks need a modern *stateless*
     * connection, and the only path to `isSessionLossError` on one is a closed
     * SSE stream, which no modern server here uses), but the guard is free.
     */
    isReplayable: () => boolean = () => true
  ): Promise<T> {
    try {
      return await operation();
    } catch (rawError) {
      // ⚠️ Classify the CONVERTED error, rethrow the ORIGINAL. The SDK's
      // transport error is not one of the typed errors this predicate tests for,
      // so without the conversion a session the remote had expired never
      // recovered — see `toTypedTransportError`. A caller still gets the
      // transport's own error text, so nothing downstream reads differently.
      if (!isSessionLossError(toTypedTransportError(rawError)) || !isReplayable()) {
        throw rawError;
      }
    }
    if (!this.recovery) {
      this.recovery = this.reinitializeAfterSessionLoss().finally(() => {
        this.recovery = undefined;
      });
    }
    await this.recovery;
    return operation();
  }

  private async reinitializeAfterSessionLoss(): Promise<void> {
    this.connected = false;
    this.initialized = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
    await this.ensureInitialized();
  }

  /**
   * Attach the Tasks runtime, once, to the client currently in use.
   *
   * ⚠️ Keyed on the client instance rather than a boolean, so the session
   * recovery above — which discards the transport *and* the client and builds
   * new ones — automatically retires a runtime that is now wired to a dead
   * transport. Attaching is a no-op for servers that do not advertise the
   * extension, and a failure to attach must never break the plain path: tasks
   * are an enhancement, so this swallows its own errors by design.
   */
  private async resolveTaskRuntime(): Promise<ToolHubTaskRuntime | undefined> {
    const client = this.sdkClient;
    const transport = this.sdkTransport;
    if (client === undefined || transport === undefined) {
      return;
    }
    const capabilities = taskRuntimeCapabilityFingerprint(client);
    if (this.taskRuntimeClient === client && this.taskRuntimeCapabilities === capabilities) {
      return;
    }
    await this.taskRuntime?.close().catch(() => undefined);
    this.taskRuntime = undefined;
    try {
      const runtime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
      // ⚠️ Issue #31: the markers move to AFTER the attempt answers. Set before
      // the `await`, a *thrown* attach retired this client for the life of the
      // connection — the guard above returned on every later call, and the plain
      // path then answered `Unsupported result type 'task'` for a server that
      // had since started advertising. `taskRuntimeClient` now names a client the
      // runtime is really attached to, which is what its comment always claimed.
      this.taskRuntime = runtime;
      this.taskRuntimeClient = client;
      this.taskRuntimeCapabilities = capabilities;
    } catch {
      // Markers deliberately left unset so the next call retries. The swallow
      // itself is intended: tasks are an enhancement and must never break the
      // plain path.
      this.taskRuntime = undefined;
    }
    return this.taskRuntime;
  }
}

// ─── HTTP (StreamableHTTP) adapter ───────────────────────────────────

class HttpMcpSdkAdapter implements McpClient {
  private sdkTransport: StreamableHTTPClientTransport | undefined;
  private sdkClient: SdkClient | undefined;
  private connected = false;
  private initialized = false;
  private era: McpProtocolEra = "legacy";
  private recovery: Promise<void> | undefined;
  /** Present only when this server advertises the Tasks extension — see toolhub-tasks.ts. */
  private taskRuntime: ToolHubTaskRuntime | undefined;
  /** The client the runtime above is attached to; a new client invalidates it. */
  private taskRuntimeClient: SdkClient | undefined;
  /** The advertised capabilities seen when that runtime was resolved (issue #31). */
  private taskRuntimeCapabilities: string | undefined;
  private static readonly probeCache = new ProtocolEraCache(60_000);

  constructor(
    private readonly server: GatewayMcpRemoteServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {
    this.era = resolveProtocolEra(this.server.protocolEra);
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.listTools();
      return this.normalizeToolList(result);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let taskBacked = false;
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      await this.resolveTaskRuntime();
      if (this.taskRuntime) {
        // The server may answer with a task handle, which the SDK's own callTool
        // cannot even parse — see toolhub-tasks.ts.
        taskBacked = true;
        return this.taskRuntime.execute(name, args, this.server.requestTimeoutMs);
      }
      // ⚠️ Pass the configured timeout explicitly. Without it the SDK falls back to
      // DEFAULT_REQUEST_TIMEOUT_MSEC (60 s), silently discarding the per-server
      // `requestTimeoutMs` the config surface carries — the pre-SDK hand-rolled client
      // used it as the default for every request. Measured 2026-10-09: a 65 s tool call
      // was rejected at 60.0 s against a server configured for 120 s.
      let result;
      try {
        result = await this.sdkClient!.callTool({ name, arguments: args }, { timeout: this.server.requestTimeoutMs });
      } catch (error) {
        if (!isUnsupportedResultTypeError(error)) {
          throw error;
        }
        // ⚠️ Issue #31. The server answered `tools/call` with a task while this
        // connection carried no runtime. The declared capabilities are captured
        // at `initialize` and never refresh on a live connection, so this
        // failure is the only reliable signal that the server now offers tasks:
        // drop the cached answer, resolve again, and retry ONCE through the
        // runtime. If the retry cannot attach, the original error surfaces.
        this.taskRuntimeClient = undefined;
        this.taskRuntimeCapabilities = undefined;
        // ⚠️ Clearing the markers is not enough: `attachToolHubTaskRuntime` reads
        // the capabilities the client captured at `initialize`, and those are
        // just as stale as the cache. Rebuild the connection so the handshake
        // re-reads what the server actually offers, then attach against that.
        await this.reinitializeAfterSessionLoss();
        const retryRuntime = await this.resolveTaskRuntime();
        if (!retryRuntime) {
          throw error;
        }
        taskBacked = true;
        return retryRuntime.execute(name, args, this.server.requestTimeoutMs);
      }
      if ((result as Record<string, unknown>).isError === true) {
        const isErrorResult = result as Record<string, unknown>;
        throw new Error(
          `Tool ${name} failed: ${JSON.stringify(isErrorResult.content ?? "no content")}`
        );
      }
      return result;
    }, () => !taskBacked);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.connected = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
  }

  /** Build the prior-discovery value for this server's era. */
  private priorDiscovery(): PriorDiscovery {
    const era = this.era;
    if (era === "legacy") {
      return { kind: "legacy" as const };
    }
    if (era === "auto") {
      const cached = HttpMcpSdkAdapter.probeCache.get(this.server.url);
      if (cached === "legacy") return { kind: "legacy" as const };
      return {
        kind: "modern" as const,
        discover: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} }
        }
      } as unknown as PriorDiscovery;
    }
    // era === "2026-07-28" (pinned modern)
    return {
      kind: "modern" as const,
      discover: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: {} }
      }
    } as unknown as PriorDiscovery;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.sdkClient) {
      const requestInit: RequestInit = {
        headers: {
          ...(this.server.headers ?? {})
        }
      };
      const apiKey = this.server.apiKey ||
        (this.server.apiKeyEnv ? process.env[this.server.apiKeyEnv] : "");
      if (apiKey) {
        const headers = requestInit.headers as Record<string, string>;
        if (!headers.authorization) {
          headers.authorization = `Bearer ${apiKey}`;
        }
      }

      // StreamableHTTPClientTransport handles streamable-HTTP and is the
      // SDK's preferred transport where possible. CCR's HTTP servers
      // speak streamable-HTTP, so this is the correct transport here.
      const sdkTransport = new StreamableHTTPClientTransport(new URL(this.server.url), {
        requestInit
      });
      this.sdkTransport = sdkTransport;
      this.sdkClient = new SdkClient(
        { name: TOOLHUB_NAME, version: "1.0.0" },
        {
          capabilities: toolHubClientCapabilities(),
          ...versionNegotiationForEra(this.era)
        }
      );
    }
    if (!this.connected) {
      const transport = this.sdkTransport!;
      if (this.era === "legacy") {
        // Legacy era: skip auto-probe, run the plain legacy handshake.
        await this.sdkClient.connect(transport, { prior: this.priorDiscovery() });
      } else if (this.era === "auto") {
        // Auto era: let SDK probe (default connect behavior).
        // The SDK probes server/discover and falls back to legacy initialize.
        await this.sdkClient.connect(transport);
      } else {
        // Pinned modern: let the SDK probe, so it learns the server's REAL
        // DiscoverResult. See versionNegotiationForEra.
        await this.sdkClient.connect(transport);
      }
      this.connected = true;
    }
    this.initialized = true;
  }

  private async withSessionRecovery<T>(
    operation: () => Promise<T>,
    /**
     * ⚠️ A task-backed call must never be replayed. The retry re-issues
     * `tools/call`, and a task-producing server answers it by creating a SECOND
     * task upstream — while the first keeps running with nobody polling it. Both
     * bill. Unreachable on today's config (tasks need a modern *stateless*
     * connection, and the only path to `isSessionLossError` on one is a closed
     * SSE stream, which no modern server here uses), but the guard is free.
     */
    isReplayable: () => boolean = () => true
  ): Promise<T> {
    try {
      return await operation();
    } catch (rawError) {
      // ⚠️ Classify the CONVERTED error, rethrow the ORIGINAL. The SDK's
      // transport error is not one of the typed errors this predicate tests for,
      // so without the conversion a session the remote had expired never
      // recovered — see `toTypedTransportError`. A caller still gets the
      // transport's own error text, so nothing downstream reads differently.
      if (!isSessionLossError(toTypedTransportError(rawError)) || !isReplayable()) {
        throw rawError;
      }
    }
    if (!this.recovery) {
      this.recovery = this.reinitializeAfterSessionLoss().finally(() => {
        this.recovery = undefined;
      });
    }
    await this.recovery;
    return operation();
  }

  private async reinitializeAfterSessionLoss(): Promise<void> {
    this.connected = false;
    this.initialized = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
    await this.ensureInitialized();
  }

  /** See the note on the SSE adapter's resolveTaskRuntime. */
  private async resolveTaskRuntime(): Promise<ToolHubTaskRuntime | undefined> {
    const client = this.sdkClient;
    const transport = this.sdkTransport;
    if (client === undefined || transport === undefined) {
      return;
    }
    const capabilities = taskRuntimeCapabilityFingerprint(client);
    if (this.taskRuntimeClient === client && this.taskRuntimeCapabilities === capabilities) {
      return;
    }
    await this.taskRuntime?.close().catch(() => undefined);
    this.taskRuntime = undefined;
    try {
      const runtime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
      // ⚠️ Issue #31: the markers move to AFTER the attempt answers. Set before
      // the `await`, a *thrown* attach retired this client for the life of the
      // connection — the guard above returned on every later call, and the plain
      // path then answered `Unsupported result type 'task'` for a server that
      // had since started advertising. `taskRuntimeClient` now names a client the
      // runtime is really attached to, which is what its comment always claimed.
      this.taskRuntime = runtime;
      this.taskRuntimeClient = client;
      this.taskRuntimeCapabilities = capabilities;
    } catch {
      // Markers deliberately left unset so the next call retries. The swallow
      // itself is intended: tasks are an enhancement and must never break the
      // plain path.
      this.taskRuntime = undefined;
    }
    return this.taskRuntime;
  }
}

// ─── Stdio adapter ───────────────────────────────────────────────────

class StdioMcpSdkAdapter implements McpClient {
  private sdkTransport: StdioClientTransport | undefined;
  private sdkClient: SdkClient | undefined;
  private connected = false;
  private initialized = false;
  private era: McpProtocolEra = "legacy";

  constructor(
    private readonly server: GatewayMcpStdioServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {
    this.era = resolveProtocolEra(this.server.protocolEra);
  }

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.sdkClient!.listTools();
    return this.normalizeToolList(result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    // See the note on the SSE adapter's callTool: the SDK default (60 s) must not
    // replace the per-server `requestTimeoutMs`.
    const result = await this.sdkClient!.callTool({ name, arguments: args }, { timeout: this.server.requestTimeoutMs });
    if ((result as Record<string, unknown>).isError === true) {
      const isErrorResult = result as Record<string, unknown>;
      throw new Error(
        `Tool ${name} failed: ${JSON.stringify(isErrorResult.content ?? "no content")}`
      );
    }
    return result;
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.connected = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
  }

  private priorDiscovery(): PriorDiscovery {
    // stdio servers are always legacy (no HTTP headers possible).
    // Forcing modern on a stdio transport will always fail.
    if (this.era === "legacy") {
      return { kind: "legacy" as const };
    }
    // auto or pinned modern — stdio auto-probe runs the probe, so
    // "auto" works. Pinned modern on stdio will throw EraNegotiationFailed
    // (expected: a stdio server cannot do modern-era headers).
    return { kind: "legacy" as const };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.sdkClient) {
      const sdkTransport = new StdioClientTransport({
        command: this.server.command,
        args: this.server.args,
        env: this.server.env,
        cwd: this.server.cwd
      });
      this.sdkTransport = sdkTransport;
      this.sdkClient = new SdkClient(
        { name: TOOLHUB_NAME, version: "1.0.0" },
        {
          capabilities: toolHubClientCapabilities()
        }
      );
    }
    if (!this.connected) {
      const transport = this.sdkTransport!;
      if (this.era === "legacy") {
        await this.sdkClient.connect(transport, { prior: this.priorDiscovery() });
      } else {
        // auto or pinned modern on stdio: let SDK auto-probe.
        // If pinned modern and server doesn't support it, SDK throws.
        await this.sdkClient.connect(transport);
      }
      this.connected = true;
    }
    this.initialized = true;
  }
}

export { HttpMcpSdkAdapter, SseMcpSdkAdapter, StdioMcpSdkAdapter };

function versionNegotiationForEra(era: McpProtocolEra): { versionNegotiation?: VersionNegotiationOptions } {
  if (era === "auto") {
    return { versionNegotiation: { mode: "auto" as const } };
  }
  if (era === "2026-07-28") {
    return { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } };
  }
  return {};
}
