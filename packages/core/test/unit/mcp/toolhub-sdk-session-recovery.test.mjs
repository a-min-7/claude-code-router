/**
 * The resolver must recover from a session the REMOTE has expired.
 *
 * ⚠️ Regression this guards, measured live 2026-10-14: the streamable-HTTP
 * transport raises its OWN error type, and `isSessionLossError` typed only on
 * `McpServerHttpError`/`McpSseStreamClosedError`, neither of which any call site
 * ever constructs. So `withSessionRecovery` classified every HTTP failure as
 * "not session loss" and rethrew: the dead session id was replayed for the life
 * of the resolver process — `404 Not Found: Session not found` from brave-mcp-rs
 * (healthy, listening, 3d12h uptime) on every call until the process respawned.
 *
 * The unit tests in `toolhub-mcp-session.test.mjs` could not catch this: they
 * build `McpServerHttpError` by hand and so prove the predicate, never the
 * recovery. This test drives the real adapter against a real HTTP fixture and
 * fails on the pre-fix code with the production error, which is the only
 * evidence that the recovery path is reachable at all.
 *
 * The fixture is session-based on purpose: it issues `mcp-session-id` on
 * initialize, honours it afterwards, and can evict it — which is exactly how an
 * rmcp server behaves when its idle TTL fires.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";

const TOOL_NAME = "brave_web_search";
const TOOL_TEXT = "SEARCH RESULT";

/**
 * A minimal session-holding MCP server whose sessions can be evicted.
 * `evictAll()` = the idle TTL fired; `failNextWith()` = any other HTTP failure.
 */
async function startSessionFixture() {
  const observed = [];
  const evicted = new Set();
  let issued = 0;
  /** Set for one request at a time to simulate a non-expiry HTTP failure. */
  let forcedFailure;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const sessionId = req.headers["mcp-session-id"];
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      observed.push({ method: body.method, sessionId });

      if (forcedFailure !== undefined && body.method !== "initialize") {
        const failure = forcedFailure;
        forcedFailure = undefined;
        res.writeHead(failure.status, { "content-type": "text/plain" });
        res.end(failure.body);
        return;
      }
      // What an rmcp server answers once its idle TTL has evicted the session.
      if (typeof sessionId === "string" && evicted.has(sessionId)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found: Session not found");
        return;
      }

      const reply = (result, headers = {}) => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };

      if (body.method === "initialize") {
        reply(
          {
            protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "session-fixture", version: "0.1.0" }
          },
          { "mcp-session-id": `session-${++issued}` }
        );
        return;
      }
      if (body.method === "tools/list") {
        reply({ tools: [{ name: TOOL_NAME, inputSchema: { type: "object", properties: { input: { type: "string" } } } }] });
        return;
      }
      if (body.method === "tools/call") {
        reply({ content: [{ type: "text", text: TOOL_TEXT }] });
        return;
      }
      reply({});
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    observed,
    initializeCount: () => observed.filter((entry) => entry.method === "initialize").length,
    /** Every session the fixture ever issued is now unknown to it. */
    evictAll: () => {
      for (const entry of observed) {
        if (typeof entry.sessionId === "string") {
          evicted.add(entry.sessionId);
        }
      }
    },
    failNextWith: (status, body) => {
      forcedFailure = { status, body };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function makeServerConfig(overrides) {
  return {
    name: "brave-search",
    transport: "streamable-http",
    url: "http://127.0.0.1:1/mcp",
    protocolEra: "legacy",
    requestTimeoutMs: 120_000,
    startupTimeoutMs: 30_000,
    headers: {},
    ...overrides
  };
}

/**
 * The known-good control: without it, a fixture that simply cannot connect would
 * make the assertions below pass for the wrong reason.
 */
test("a session-based fixture serves a call while its session is live", async () => {
  const fixture = await startSessionFixture();
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value.tools ?? []);
  try {
    await adapter.listTools();
    const result = await adapter.callTool(TOOL_NAME, { input: "q" });
    assert.equal(result.content[0].text, TOOL_TEXT);
    assert.equal(fixture.initializeCount(), 1, "a live session must not be re-initialized");
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

/**
 * THE PIN. Pre-fix this rejects with the production error
 * (`Error POSTing to endpoint: Not Found: Session not found`) because the
 * predicate never matched; post-fix it resolves on the first retry.
 */
test("a call recovers when the remote has evicted the session", async () => {
  const fixture = await startSessionFixture();
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value.tools ?? []);
  try {
    await adapter.listTools();
    fixture.evictAll(); // the idle TTL fires between the two calls

    const result = await adapter.callTool(TOOL_NAME, { input: "q" });
    assert.equal(result.content[0].text, TOOL_TEXT, "the retry must return the server's answer");
    assert.equal(fixture.initializeCount(), 2, "recovery must re-initialize exactly once");
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

/**
 * The other half of the same rule: recovery must stay narrow. A 404 for a
 * missing route is not a dead session, and re-initializing on it would mask a
 * real fault behind a retry.
 */
test("a non-expiry 404 does NOT re-initialize the session", async () => {
  const fixture = await startSessionFixture();
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value.tools ?? []);
  try {
    await adapter.listTools();
    fixture.failNextWith(404, "Not Found");

    await assert.rejects(() => adapter.callTool(TOOL_NAME, { input: "q" }));
    assert.equal(fixture.initializeCount(), 1, "a missing route must not trigger a recovery");
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

/** 5xx is a server fault; re-initializing cannot help and must not be tried. */
test("a 5xx does NOT re-initialize the session", async () => {
  const fixture = await startSessionFixture();
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value.tools ?? []);
  try {
    await adapter.listTools();
    fixture.failNextWith(500, "Session not found");

    await assert.rejects(() => adapter.callTool(TOOL_NAME, { input: "q" }));
    assert.equal(fixture.initializeCount(), 1, "a server fault must not trigger a recovery");
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
