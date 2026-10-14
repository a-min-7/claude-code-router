import assert from "node:assert/strict";
import test from "node:test";
import {
  isSessionExpiryHttpStatus,
  isSessionLossError,
  McpServerHttpError,
  McpSseStreamClosedError,
  toTypedTransportError
} from "@ccr/core/mcp/toolhub-mcp-session.ts";

test("isSessionExpiryHttpStatus treats 410 Gone as session loss", () => {
  assert.equal(isSessionExpiryHttpStatus(410, ""), true);
  assert.equal(isSessionExpiryHttpStatus(410, "anything at all"), true);
});

test("isSessionExpiryHttpStatus matches observed rmcp expiry responses", () => {
  // the live failure that motivated this fix
  assert.equal(isSessionExpiryHttpStatus(404, "Session not found"), true);
  // a fresh-connection request the server rejects because it wants initialize first
  assert.equal(isSessionExpiryHttpStatus(422, "Unexpected message, expect initialize request"), true);
});

test("isSessionExpiryHttpStatus is body-gated: 4xx without a session signal is NOT expiry", () => {
  // missing route / wrong path — must not trigger a session re-initialize
  assert.equal(isSessionExpiryHttpStatus(404, "Not Found"), false);
  assert.equal(isSessionExpiryHttpStatus(404, "<html>404</html>"), false);
  assert.equal(isSessionExpiryHttpStatus(422, "Unprocessable entity"), false);
  assert.equal(isSessionExpiryHttpStatus(400, "bad request"), false);
});

test("isSessionExpiryHttpStatus never treats 5xx/2xx/other 4xx as session loss", () => {
  // 5xx is a server fault, not a dead session — re-initializing cannot help
  assert.equal(isSessionExpiryHttpStatus(500, "Session not found"), false);
  assert.equal(isSessionExpiryHttpStatus(503, "session expired"), false);
  // auth failures are not session-expiry either
  assert.equal(isSessionExpiryHttpStatus(401, "session invalid"), false);
  assert.equal(isSessionExpiryHttpStatus(403, "forbidden session"), false);
  assert.equal(isSessionExpiryHttpStatus(200, "Session not found"), false);
});

test("isSessionLossError classifies typed transport errors", () => {
  const httpExpired = new McpServerHttpError("x", 404, "Session not found");
  assert.equal(isSessionLossError(httpExpired), true);
  const httpMissingRoute = new McpServerHttpError("x", 404, "Not Found");
  assert.equal(isSessionLossError(httpMissingRoute), false);
  const httpServerDown = new McpServerHttpError("x", 500, "boom");
  assert.equal(isSessionLossError(httpServerDown), false);
  const sseClosed = new McpSseStreamClosedError("MCP SSE stream closed (x).");
  assert.equal(isSessionLossError(sseClosed), true);
});

test("isSessionLossError does NOT recover from untagged or non-error values", () => {
  // plain errors (e.g. tool-level JSON-RPC errors, timeouts) never auto-recover —
  // matching only the typed transport classes keeps recovery narrow
  assert.equal(isSessionLossError(new Error("MCP HTTP request failed (x): 404 Session not found")), false);
  assert.equal(isSessionLossError(new Error("Session not found")), false);
  assert.equal(isSessionLossError("Session not found"), false);
  assert.equal(isSessionLossError(undefined), false);
  assert.equal(isSessionLossError(null), false);
});

// ---------------------------------------------------------------------------
// The conversion that makes the predicate above reachable in production.
//
// ⚠️ `isSessionLossError` types on errors THIS MODULE declares, and the SDK
// throws none of them — `new McpServerHttpError(` had no call site anywhere, so
// the recovery path was dead code for every HTTP MCP: a session the remote had
// expired was replayed for the life of the resolver process. The shapes below
// are the ones the transport actually raises, taken from the live failure
// (`Error POSTing to endpoint: Not Found: Session not found` against rmcp).
// ---------------------------------------------------------------------------

test("toTypedTransportError re-tags the SDK's own error shapes", () => {
  // @modelcontextprotocol/client raises an McpError carrying the HTTP status and
  // the response text on `data` — the shape measured live against brave-mcp-rs.
  const sdkError = Object.assign(new Error("Error POSTing to endpoint: Not Found: Session not found"), {
    code: -32603,
    data: { status: 404, statusText: "Not Found", text: "Not Found: Session not found" }
  });
  const converted = toTypedTransportError(sdkError);
  assert.ok(converted instanceof McpServerHttpError, "the SDK error must be re-tagged");
  assert.equal(converted.status, 404);
  assert.equal(converted.body, "Not Found: Session not found");
  assert.equal(isSessionLossError(converted), true);

  // The other POST path in the same transport raises a plain Error with the
  // status embedded in the message.
  const plainError = new Error("Error POSTing to endpoint (HTTP 404): Not Found: Session not found");
  const convertedPlain = toTypedTransportError(plainError);
  assert.ok(convertedPlain instanceof McpServerHttpError);
  assert.equal(convertedPlain.status, 404);
  assert.equal(isSessionLossError(convertedPlain), true);
});

test("toTypedTransportError keeps the narrowness: no status means no re-tag", () => {
  // Returned UNCHANGED, so the guard directly above still holds.
  const bare = new Error("Session not found");
  assert.equal(toTypedTransportError(bare), bare, "an untagged error must pass through untouched");
  assert.equal(isSessionLossError(toTypedTransportError(bare)), false);
  assert.equal(toTypedTransportError("Session not found"), "Session not found");
  assert.equal(toTypedTransportError(undefined), undefined);
});

test("toTypedTransportError re-tags a NON-expiry 4xx without making it recoverable", () => {
  // A dead session and a missing route are both 404s; only the body separates
  // them. Re-initializing on the second would mask a real fault.
  const missingRoute = Object.assign(new Error("Error POSTing to endpoint: Not Found"), {
    data: { status: 404, text: "Not Found" }
  });
  assert.ok(toTypedTransportError(missingRoute) instanceof McpServerHttpError);
  assert.equal(isSessionLossError(toTypedTransportError(missingRoute)), false);

  const serverDown = Object.assign(new Error("Error POSTing to endpoint: boom"), {
    data: { status: 500, text: "boom" }
  });
  assert.equal(isSessionLossError(toTypedTransportError(serverDown)), false);
});

test("toTypedTransportError leaves already-typed errors identical", () => {
  const typed = new McpServerHttpError("x", 404, "Session not found");
  assert.equal(toTypedTransportError(typed), typed);
  const sse = new McpSseStreamClosedError("closed");
  assert.equal(toTypedTransportError(sse), sse);
});
