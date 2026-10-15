/**
 * The session-based ToolHub MCP clients — the thin wrappers that own an SDK
 * adapter's lifetime for the two transports that hold a server-side SESSION
 * (streamable-HTTP and SSE). `StdioMcpClient` stays in `toolhub-mcp.ts`: a stdio
 * child has no session to lose, so nothing here is shared with it.
 *
 * ⚠️ Why these live outside `toolhub-mcp.ts`: that file is an esbuild ENTRY POINT
 * (`build/esbuild.config.mjs`), so importing it from a test RUNS the resolver —
 * it attaches `process.stdin` handlers and constructs the runtime at module
 * scope. Session-loss recovery is the part of these classes that most needs a
 * test, and it could not be reached from there. Extracting them is what makes
 * `test/unit/mcp/toolhub-sdk-session-recovery.test.mjs` able to drive the REAL
 * wrapper instead of only the adapter beneath it.
 *
 * ⚠️ **Session loss is owned by the ADAPTER, not here.** These classes used to
 * carry a `withSessionRecovery` of their own that tested `isSessionLossError(error)`
 * on the RAW error — the same miswired predicate `f5f2229a` fixed one layer down,
 * and just as unreachable: every operation here calls `this.sdkAdapter!.x()`, and
 * both adapters' `listTools`/`callTool` already run through their own
 * `withSessionRecovery`, which rethrows the ORIGINAL transport error. So the only
 * errors that ever reached this layer were (i) non-session-loss (correctly
 * surfaced) and (ii) session-loss whose adapter retry had already failed — and a
 * second layer cannot help with (ii): it holds no session state of its own, only
 * the adapter, which already rebuilds its transport AND its client. Converting it
 * would only add a third upstream attempt with no backoff, plus a second owner of
 * `initialized` — the duplication whose appearance of protection this defect was.
 * Deleted instead; the count pinned by toolhub-sdk-session-recovery.test.mjs is
 * what discriminates the two options (one recovery, not two).
 */

import { SseMcpSdkAdapter, HttpMcpSdkAdapter } from "./toolhub-sdk-adapters";
import type { NormalizedRemoteServerConfig } from "./toolhub-server-config";

// ── Type mirrors of toolhub-mcp.ts, as in toolhub-sdk-adapters.ts ────

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

/** Passed through to the adapter; kept a parameter so this module owns no policy. */
type NormalizeToolList = (value: unknown) => ToolDefinition[];

export class SseMcpClient implements McpClient {
  private sdkAdapter: SseMcpSdkAdapter | undefined;
  private initialized = false;

  constructor(
    private readonly server: NormalizedRemoteServerConfig,
    private readonly normalizeToolList: NormalizeToolList
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    return this.sdkAdapter!.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.sdkAdapter!.callTool(name, args);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.sdkAdapter = undefined;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.sdkAdapter) {
      this.sdkAdapter = new SseMcpSdkAdapter(this.server, this.normalizeToolList);
    }
    await this.sdkAdapter.listTools(); // triggers lazy init
    this.initialized = true;
  }
}

export class HttpMcpClient implements McpClient {
  private sdkAdapter: HttpMcpSdkAdapter | undefined;
  private initialized = false;

  constructor(
    private readonly server: NormalizedRemoteServerConfig,
    private readonly normalizeToolList: NormalizeToolList
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    return this.sdkAdapter!.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.sdkAdapter!.callTool(name, args);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.sdkAdapter = undefined;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.sdkAdapter) {
      this.sdkAdapter = new HttpMcpSdkAdapter(this.server, this.normalizeToolList);
    }
    await this.sdkAdapter.listTools(); // triggers lazy init
    this.initialized = true;
  }
}
