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
 * How long one failed task-runtime recovery suppresses the next one (issue #31
 * review). Without it, a server that keeps answering with a task it cannot
 * support makes every `tools/call` rebuild the connection — one leaked handshake
 * per call, forever.
 */
const TASK_RECOVERY_COOLDOWN_MS = 30_000;

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

/** Render a throwable for a log line without assuming it is an `Error`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /**
   * In-flight attach, shared by concurrent callers so only ONE runtime is built
   * (issue #31 review) — and KEYED ON THE CLIENT it was started for (issue #34),
   * so a caller on a rebuilt client never joins an attach that is still working
   * against the client the recovery just discarded.
   */
  private taskRuntimeAttach:
    | { capabilities: string; client: SdkClient; promise: Promise<ToolHubTaskRuntime | undefined> }
    | undefined;
  /** Epoch ms before which a second recovery attempt is refused, so a non-conforming server cannot leak a handshake per call. */
  private taskRuntimeRecoveryAfter: number | undefined;
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
        // at `initialize` and never refresh on a live connection, so this failure
        // is the only reliable signal that the server now offers tasks.
        //
        // ⚠️ THE FIRST TASK IS ORPHANED BY DESIGN (issue #31 review). It is
        // already running upstream, and its handle died in the SDK decoder — the
        // rejection carries only `{resultType, method}` — so it can be neither
        // polled nor cancelled. The retry sends a SECOND one. `withSessionRecovery`
        // forbids replaying a task-backed call for exactly this reason; here the
        // alternative is to fail while the orphan runs anyway, so one retry is
        // the lesser cost, and it happens at most once per call.
        if (this.taskRuntimeRecoveryAfter !== undefined && Date.now() < this.taskRuntimeRecoveryAfter) {
          // A recent recovery already failed. Churning another handshake per call
          // leaks a connection for no benefit, so surface the original error.
          throw error;
        }
        // ⚠️ ONE recovery at a time (issue #33). `recoverSession(true)` closes the
        // discarded client, and that close settles every in-flight request on it
        // with `ConnectionClosed`; a second caller that passed this gate while the
        // first was rebuilding used to close the FIRST caller's freshly built
        // client. Sharing one single-flight rebuild makes the second caller await
        // the first instead.
        //
        // ⚠️ Clearing the markers is not enough on its own: `attachToolHubTaskRuntime`
        // reads the capabilities the client captured at `initialize`, and those are
        // just as stale as the cache. Rebuild the connection so the handshake
        // re-reads what the server actually offers, then attach against that. The
        // discarded client is CLOSED first — it is live, not dead, so leaving it
        // open would leak a connection per recovery.
        try {
          await this.recoverSession(true);
        } catch (reconnectFailure) {
          // The caller needs the error that actually describes the call, not the
          // reconnect's. Preserve the original and attach the failure as `cause`.
          this.taskRuntimeRecoveryAfter = Date.now() + TASK_RECOVERY_COOLDOWN_MS;
          if (error instanceof Error && error.cause === undefined) {
            (error as { cause?: unknown }).cause = reconnectFailure;
          } else {
            // The original error cannot carry the cause — it is not an `Error`, or
            // it already has one — so log the reconnect failure instead of
            // dropping it on the floor (issue #34).
            console.warn(
              `[${this.server.name}] Task-runtime recovery failed to reconnect: ${describeError(reconnectFailure)}`
            );
          }
          throw error;
        }
        const retryRuntime = await this.resolveTaskRuntime();
        if (!retryRuntime) {
          this.taskRuntimeRecoveryAfter = Date.now() + TASK_RECOVERY_COOLDOWN_MS;
          throw error;
        }
        this.taskRuntimeRecoveryAfter = undefined;
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
    await this.recoverSession(false);
    return operation();
  }

  /**
   * Rebuild the connection ONCE however many callers need it (issue #33).
   *
   * `closeDiscardedClient` closes the client being replaced — and only the caller
   * that STARTS the recovery decides, so a joiner never closes the rebuild it
   * joined. A task-runtime recovery asks for the close because its discarded
   * client is still live and would otherwise leak a connection; a session-loss
   * replay does not, because the transport it is replacing is already gone.
   */
  private recoverSession(closeDiscardedClient: boolean): Promise<void> {
    if (this.recovery === undefined) {
      this.recovery = (async () => {
        if (closeDiscardedClient) {
          // The task runtime names the client being discarded, so retire the
          // markers in the same critical section that replaces it.
          this.taskRuntimeClient = undefined;
          this.taskRuntimeCapabilities = undefined;
          const discarded = this.sdkClient;
          await discarded?.close().catch(() => undefined);
        }
        await this.reinitializeAfterSessionLoss();
      })().finally(() => {
        this.recovery = undefined;
      });
    }
    return this.recovery;
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
      return undefined;
    }
    const capabilities = taskRuntimeCapabilityFingerprint(client);
    if (this.taskRuntimeClient === client && this.taskRuntimeCapabilities === capabilities) {
      return this.taskRuntime;
    }
    // ⚠️ ONE attach per client/capability pair, shared by concurrent callers
    // (issue #31 review). Since the markers are now set only AFTER the attach,
    // two parallel `tools/call`s would both pass the guard above and install two
    // RawRequestChannels on one transport — whose counters start at the same id,
    // so responses cross. The in-flight promise closes that window.
    //
    // ⚠️ Keyed on the client it was started for (issue #34): the recovery block
    // replaces the client, and a caller arriving after the rebuild must not await
    // an attach that is still working against the discarded one.
    const pending = this.taskRuntimeAttach;
    if (pending !== undefined && pending.client === client && pending.capabilities === capabilities) {
      return pending.promise;
    }
    const promise = this.attachTaskRuntime(client, transport, capabilities);
    this.taskRuntimeAttach = { client, capabilities, promise };
    promise
      .catch(() => undefined)
      .finally(() => {
        if (this.taskRuntimeAttach?.promise === promise) {
          this.taskRuntimeAttach = undefined;
        }
      });
    return promise;
  }

  private async attachTaskRuntime(
    client: SdkClient,
    transport: Parameters<typeof attachToolHubTaskRuntime>[0]["transport"],
    capabilities: string
  ): Promise<ToolHubTaskRuntime | undefined> {
    // Close only the runtime that existed when this attach STARTED, never
    // `this.taskRuntime` as it stands after the await: an attach for a discarded
    // client can still be in flight beside one for its replacement (issue #34).
    const previous = this.taskRuntime;
    this.taskRuntime = undefined;
    await previous?.close().catch(() => undefined);
    try {
      const runtime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
      if (this.sdkClient !== client) {
        // The connection was replaced while this attach was in flight, so the
        // runtime (if any) is wired to a discarded transport. Keep it out of the
        // fields and release it; the current client gets its own attach (#34).
        await runtime?.close().catch(() => undefined);
        return undefined;
      }
      this.taskRuntime = runtime;
      this.taskRuntimeClient = client;
      this.taskRuntimeCapabilities = capabilities;
      // A working attach means the task path is healthy again, so a cooldown that
      // an earlier failed recovery armed must not keep suppressing recoveries for
      // the rest of its window (issue #34).
      this.taskRuntimeRecoveryAfter = undefined;
      return runtime;
    } catch {
      // Markers deliberately left unset so the next call retries. The swallow
      // itself is intended: tasks are an enhancement and must never break the
      // plain path.
      return undefined;
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
  /** The advertised capabilities seen when that runtime was resolved (issue #31). */
  private taskRuntimeCapabilities: string | undefined;
  /**
   * In-flight attach, shared by concurrent callers so only ONE runtime is built
   * (issue #31 review) — and KEYED ON THE CLIENT it was started for (issue #34),
   * so a caller on a rebuilt client never joins an attach that is still working
   * against the client the recovery just discarded.
   */
  private taskRuntimeAttach:
    | { capabilities: string; client: SdkClient; promise: Promise<ToolHubTaskRuntime | undefined> }
    | undefined;
  /** Epoch ms before which a second recovery attempt is refused, so a non-conforming server cannot leak a handshake per call. */
  private taskRuntimeRecoveryAfter: number | undefined;
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
        // at `initialize` and never refresh on a live connection, so this failure
        // is the only reliable signal that the server now offers tasks.
        //
        // ⚠️ THE FIRST TASK IS ORPHANED BY DESIGN (issue #31 review). It is
        // already running upstream, and its handle died in the SDK decoder — the
        // rejection carries only `{resultType, method}` — so it can be neither
        // polled nor cancelled. The retry sends a SECOND one. `withSessionRecovery`
        // forbids replaying a task-backed call for exactly this reason; here the
        // alternative is to fail while the orphan runs anyway, so one retry is
        // the lesser cost, and it happens at most once per call.
        if (this.taskRuntimeRecoveryAfter !== undefined && Date.now() < this.taskRuntimeRecoveryAfter) {
          // A recent recovery already failed. Churning another handshake per call
          // leaks a connection for no benefit, so surface the original error.
          throw error;
        }
        // ⚠️ ONE recovery at a time (issue #33). `recoverSession(true)` closes the
        // discarded client, and that close settles every in-flight request on it
        // with `ConnectionClosed`; a second caller that passed this gate while the
        // first was rebuilding used to close the FIRST caller's freshly built
        // client. Sharing one single-flight rebuild makes the second caller await
        // the first instead.
        //
        // ⚠️ Clearing the markers is not enough on its own: `attachToolHubTaskRuntime`
        // reads the capabilities the client captured at `initialize`, and those are
        // just as stale as the cache. Rebuild the connection so the handshake
        // re-reads what the server actually offers, then attach against that. The
        // discarded client is CLOSED first — it is live, not dead, so leaving it
        // open would leak a connection per recovery.
        try {
          await this.recoverSession(true);
        } catch (reconnectFailure) {
          // The caller needs the error that actually describes the call, not the
          // reconnect's. Preserve the original and attach the failure as `cause`.
          this.taskRuntimeRecoveryAfter = Date.now() + TASK_RECOVERY_COOLDOWN_MS;
          if (error instanceof Error && error.cause === undefined) {
            (error as { cause?: unknown }).cause = reconnectFailure;
          } else {
            // The original error cannot carry the cause — it is not an `Error`, or
            // it already has one — so log the reconnect failure instead of
            // dropping it on the floor (issue #34).
            console.warn(
              `[${this.server.name}] Task-runtime recovery failed to reconnect: ${describeError(reconnectFailure)}`
            );
          }
          throw error;
        }
        const retryRuntime = await this.resolveTaskRuntime();
        if (!retryRuntime) {
          this.taskRuntimeRecoveryAfter = Date.now() + TASK_RECOVERY_COOLDOWN_MS;
          throw error;
        }
        this.taskRuntimeRecoveryAfter = undefined;
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
    await this.recoverSession(false);
    return operation();
  }

  /**
   * Rebuild the connection ONCE however many callers need it (issue #33).
   *
   * `closeDiscardedClient` closes the client being replaced — and only the caller
   * that STARTS the recovery decides, so a joiner never closes the rebuild it
   * joined. A task-runtime recovery asks for the close because its discarded
   * client is still live and would otherwise leak a connection; a session-loss
   * replay does not, because the transport it is replacing is already gone.
   */
  private recoverSession(closeDiscardedClient: boolean): Promise<void> {
    if (this.recovery === undefined) {
      this.recovery = (async () => {
        if (closeDiscardedClient) {
          // The task runtime names the client being discarded, so retire the
          // markers in the same critical section that replaces it.
          this.taskRuntimeClient = undefined;
          this.taskRuntimeCapabilities = undefined;
          const discarded = this.sdkClient;
          await discarded?.close().catch(() => undefined);
        }
        await this.reinitializeAfterSessionLoss();
      })().finally(() => {
        this.recovery = undefined;
      });
    }
    return this.recovery;
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
      return undefined;
    }
    const capabilities = taskRuntimeCapabilityFingerprint(client);
    if (this.taskRuntimeClient === client && this.taskRuntimeCapabilities === capabilities) {
      return this.taskRuntime;
    }
    // ⚠️ ONE attach per client/capability pair, shared by concurrent callers
    // (issue #31 review). Since the markers are now set only AFTER the attach,
    // two parallel `tools/call`s would both pass the guard above and install two
    // RawRequestChannels on one transport — whose counters start at the same id,
    // so responses cross. The in-flight promise closes that window.
    //
    // ⚠️ Keyed on the client it was started for (issue #34): the recovery block
    // replaces the client, and a caller arriving after the rebuild must not await
    // an attach that is still working against the discarded one.
    const pending = this.taskRuntimeAttach;
    if (pending !== undefined && pending.client === client && pending.capabilities === capabilities) {
      return pending.promise;
    }
    const promise = this.attachTaskRuntime(client, transport, capabilities);
    this.taskRuntimeAttach = { client, capabilities, promise };
    promise
      .catch(() => undefined)
      .finally(() => {
        if (this.taskRuntimeAttach?.promise === promise) {
          this.taskRuntimeAttach = undefined;
        }
      });
    return promise;
  }

  private async attachTaskRuntime(
    client: SdkClient,
    transport: Parameters<typeof attachToolHubTaskRuntime>[0]["transport"],
    capabilities: string
  ): Promise<ToolHubTaskRuntime | undefined> {
    // Close only the runtime that existed when this attach STARTED, never
    // `this.taskRuntime` as it stands after the await: an attach for a discarded
    // client can still be in flight beside one for its replacement (issue #34).
    const previous = this.taskRuntime;
    this.taskRuntime = undefined;
    await previous?.close().catch(() => undefined);
    try {
      const runtime = await attachToolHubTaskRuntime({
        client,
        transport,
        server: { name: this.server.name, url: this.server.url },
        serverConfigTimeoutMs: this.server.requestTimeoutMs,
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        clientCapabilities: toolHubClientCapabilities()
      });
      if (this.sdkClient !== client) {
        // The connection was replaced while this attach was in flight, so the
        // runtime (if any) is wired to a discarded transport. Keep it out of the
        // fields and release it; the current client gets its own attach (#34).
        await runtime?.close().catch(() => undefined);
        return undefined;
      }
      this.taskRuntime = runtime;
      this.taskRuntimeClient = client;
      this.taskRuntimeCapabilities = capabilities;
      // A working attach means the task path is healthy again, so a cooldown that
      // an earlier failed recovery armed must not keep suppressing recoveries for
      // the rest of its window (issue #34).
      this.taskRuntimeRecoveryAfter = undefined;
      return runtime;
    } catch {
      // Markers deliberately left unset so the next call retries. The swallow
      // itself is intended: tasks are an enhancement and must never break the
      // plain path.
      return undefined;
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
