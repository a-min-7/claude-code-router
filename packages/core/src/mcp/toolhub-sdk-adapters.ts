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
import { isSessionLossError } from "@ccr/core/mcp/toolhub-mcp-session";
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
      const result = await this.sdkClient!.callTool({ name, arguments: args }, { timeout: this.server.requestTimeoutMs });
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
    } catch (error) {
      if (!isSessionLossError(error) || !isReplayable()) {
        throw error;
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
  private async resolveTaskRuntime(): Promise<void> {
    const client = this.sdkClient;
    const transport = this.sdkTransport;
    if (client === undefined || transport === undefined || this.taskRuntimeClient === client) {
      return;
    }
    await this.taskRuntime?.close().catch(() => undefined);
    this.taskRuntime = undefined;
    this.taskRuntimeClient = client;
    try {
      this.taskRuntime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
    } catch {
      this.taskRuntime = undefined;
    }
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
      const result = await this.sdkClient!.callTool({ name, arguments: args }, { timeout: this.server.requestTimeoutMs });
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
    } catch (error) {
      if (!isSessionLossError(error) || !isReplayable()) {
        throw error;
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
  private async resolveTaskRuntime(): Promise<void> {
    const client = this.sdkClient;
    const transport = this.sdkTransport;
    if (client === undefined || transport === undefined || this.taskRuntimeClient === client) {
      return;
    }
    await this.taskRuntime?.close().catch(() => undefined);
    this.taskRuntime = undefined;
    this.taskRuntimeClient = client;
    try {
      this.taskRuntime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
    } catch {
      this.taskRuntime = undefined;
    }
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
