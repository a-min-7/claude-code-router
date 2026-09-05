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
