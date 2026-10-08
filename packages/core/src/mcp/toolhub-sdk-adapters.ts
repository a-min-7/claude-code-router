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
  type InitializeRequest
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LEGACY_PROTOCOL_VERSION } from "@ccr/core/mcp/protocol-era";
import { isSessionLossError } from "@ccr/core/mcp/toolhub-mcp-session";

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

type GatewayMcpRemoteServerConfig = {
  label?: string;
  name: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  transport: "streamable-http" | "sse";
  url: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
};

type GatewayMcpStdioServerConfig = {
  label?: string;
  name: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdioMessageMode?: "content-length" | "newline-json";
};

// ── Shared constants ────────────────────────────────────────────────

const LEGACY = LEGACY_PROTOCOL_VERSION;
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
  private recovery: Promise<void> | undefined;

  constructor(
    private readonly server: GatewayMcpRemoteServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.listTools();
      return this.normalizeToolList(result);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.callTool({ name, arguments: args });
      if ((result as Record<string, unknown>).isError === true) {
        const isErrorResult = result as Record<string, unknown>;
        throw new Error(
          `Tool ${name} failed: ${JSON.stringify(isErrorResult.content ?? "no content")}`
        );
      }
      return result;
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.connected = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
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
          capabilities: {}
        }
      );
    }
    if (!this.connected) {
      const transport = this.sdkTransport!;
      await this.sdkClient.connect(transport);
      this.connected = true;
    }
    // Send initialize request via SDK's request() method.
    const initializeRequest: InitializeRequest = {
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        protocolVersion: this.server.protocolVersion ?? LEGACY
      }
    };
    await this.sdkClient.request(initializeRequest);
    // Send initialized notification.
    await this.sdkClient.notification({ method: "notifications/initialized" }).catch(() => undefined);
    this.initialized = true;
  }

  private async withSessionRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isSessionLossError(error)) {
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
}

// ─── HTTP (StreamableHTTP) adapter ───────────────────────────────────

class HttpMcpSdkAdapter implements McpClient {
  private sdkTransport: StreamableHTTPClientTransport | undefined;
  private sdkClient: SdkClient | undefined;
  private connected = false;
  private initialized = false;
  private recovery: Promise<void> | undefined;

  constructor(
    private readonly server: GatewayMcpRemoteServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.listTools();
      return this.normalizeToolList(result);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withSessionRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.sdkClient!.callTool({ name, arguments: args });
      if ((result as Record<string, unknown>).isError === true) {
        const isErrorResult = result as Record<string, unknown>;
        throw new Error(
          `Tool ${name} failed: ${JSON.stringify(isErrorResult.content ?? "no content")}`
        );
      }
      return result;
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.connected = false;
    this.sdkTransport = undefined;
    this.sdkClient = undefined;
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
          capabilities: {}
        }
      );
    }
    if (!this.connected) {
      await this.sdkClient.connect(this.sdkTransport!);
      this.connected = true;
    }
    const initializeRequest: InitializeRequest = {
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        protocolVersion: this.server.protocolVersion ?? LEGACY
      }
    };
    await this.sdkClient.request(initializeRequest);
    await this.sdkClient.notification({ method: "notifications/initialized" }).catch(() => undefined);
    this.initialized = true;
  }

  private async withSessionRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isSessionLossError(error)) {
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
}

// ─── Stdio adapter ───────────────────────────────────────────────────

class StdioMcpSdkAdapter implements McpClient {
  private sdkTransport: StdioClientTransport | undefined;
  private sdkClient: SdkClient | undefined;
  private connected = false;
  private initialized = false;

  constructor(
    private readonly server: GatewayMcpStdioServerConfig,
    private readonly normalizeToolList: (value: unknown) => ToolDefinition[]
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.sdkClient!.listTools();
    return this.normalizeToolList(result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.sdkClient!.callTool({ name, arguments: args });
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
          capabilities: {}
        }
      );
    }
    if (!this.connected) {
      await this.sdkClient.connect(this.sdkTransport!);
      this.connected = true;
    }
    const initializeRequest: InitializeRequest = {
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: TOOLHUB_NAME, version: "1.0.0" },
        protocolVersion: this.server.protocolVersion ?? LEGACY
      }
    };
    await this.sdkClient.request(initializeRequest);
    this.initialized = true;
  }
}

export { HttpMcpSdkAdapter, SseMcpSdkAdapter, StdioMcpSdkAdapter };
