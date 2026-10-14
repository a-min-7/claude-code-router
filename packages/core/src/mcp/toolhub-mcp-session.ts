/**
 * Session-loss detection + typed transport errors for the ToolHub MCP
 * HTTP/SSE clients (toolhub-mcp.ts).
 *
 * Streamable-HTTP and SSE MCP servers may expire or evict a client session at
 * any time (idle TTL, session-capacity, server restart). The clients in
 * toolhub-mcp.ts reuse one session per server for their whole process lifetime,
 * so they must recognize when the server no longer knows that session and
 * recover by re-initializing — otherwise every later call replays a dead
 * session id and fails (e.g. `404 Not Found: Session not found`) until the
 * resolver process restarts.
 *
 * This module owns the *narrow* expiry predicate + the error types so the
 * classification can be unit-tested in isolation; the recovery orchestration
 * (reset → re-initialize → retry-once) lives in the client classes.
 */

/**
 * HTTP-level error from a remote MCP server (transport/status layer), carrying
 * the status + body so session-expiry can be told apart from any other failure
 * (5xx, wrong route, auth, ...).
 */
export class McpServerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "McpServerHttpError";
  }
}

/**
 * The server closed the SSE event stream — the client session is over. A fresh
 * GET (and thus a fresh session) is required before the next request.
 */
export class McpSseStreamClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSseStreamClosedError";
  }
}

/**
 * True when an HTTP status + body indicates the server no longer recognizes
 * the client's MCP session (or requires a fresh initialize). Deliberately
 * narrow: arbitrary 4xx/5xx must NOT trigger a session re-initialize, because
 * blindly re-initializing there would mask real failures and add latency.
 */
export function isSessionExpiryHttpStatus(status: number, body: string): boolean {
  // 410 Gone is the HTTP-standard "session expired/revoked" signal.
  if (status === 410) {
    return true;
  }
  // Observed in the wild (rmcp streamable-HTTP): 404 "Session not found",
  // 422 "Unexpected message, expect initialize request". Gate on the body so a
  // 404 for e.g. a missing route is not mistaken for session loss.
  if (status === 400 || status === 404 || status === 422) {
    return /session|initialize|expire/i.test(body);
  }
  return false;
}

/** True when an error means the remote MCP session/stream is gone. */
export function isSessionLossError(error: unknown): boolean {
  if (error instanceof McpServerHttpError) {
    return isSessionExpiryHttpStatus(error.status, error.body);
  }
  if (error instanceof McpSseStreamClosedError) {
    return true;
  }
  return false;
}

/**
 * Re-tag a transport failure as {@link McpServerHttpError} when — and only
 * when — it carries an HTTP status.
 *
 * ⚠️ Why this exists at all: the predicate above types on errors this module
 * declares, but nothing in the SDK *throws* them. `HttpMcpSdkAdapter` calls
 * `@modelcontextprotocol/client`, whose streamable-HTTP transport raises its own
 * error type with the status and the response text on `data` (or a plain
 * `Error(\`Error POSTing to endpoint (HTTP 404): …\`)`). So the recovery path in
 * `toolhub-sdk-adapters.ts` never fired for HTTP servers: a session the remote
 * had expired was replayed for the life of the resolver process — the "404 Not
 * Found: Session not found" failure this module was written to fix. The typed
 * errors were declared and tested but never produced.
 *
 * Deliberately conservative: an error with no HTTP status (a timeout, a bare
 * `Error`, a non-Error) is returned UNCHANGED, so `isSessionLossError` keeps
 * rejecting it — re-initializing a session on an unclassified failure would mask
 * real faults and add latency.
 */
export function toTypedTransportError(error: unknown): unknown {
  if (error instanceof McpServerHttpError || error instanceof McpSseStreamClosedError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return error;
  }
  const status = readHttpStatus(error);
  if (status === undefined) {
    return error;
  }
  return new McpServerHttpError(error.message, status, readHttpBody(error));
}

/** HTTP status from an SDK transport error, however it chose to carry it. */
function readHttpStatus(error: Error): number | undefined {
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number" && Number.isInteger(direct)) {
    return direct;
  }
  const data = (error as { data?: { status?: unknown } }).data;
  if (data && typeof data.status === "number" && Number.isInteger(data.status)) {
    return data.status;
  }
  const matched = /Error POSTing to endpoint \(HTTP (\d{3})\)/.exec(error.message);
  return matched ? Number(matched[1]) : undefined;
}

/** Response body from an SDK transport error, falling back to its message. */
function readHttpBody(error: Error): string {
  const direct = (error as { body?: unknown }).body;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const data = (error as { data?: { text?: unknown; body?: unknown } }).data;
  if (data) {
    if (typeof data.text === "string" && data.text.length > 0) {
      return data.text;
    }
    if (typeof data.body === "string" && data.body.length > 0) {
      return data.body;
    }
  }
  const matched = /Error POSTing to endpoint \(HTTP \d{3}\):\s*([\s\S]*)$/.exec(error.message);
  if (matched && matched[1].length > 0) {
    return matched[1];
  }
  return error.message;
}
