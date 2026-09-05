import assert from "node:assert/strict";
import test from "node:test";
import {
  isSessionExpiryHttpStatus,
  isSessionLossError,
  McpServerHttpError,
  McpSseStreamClosedError
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
