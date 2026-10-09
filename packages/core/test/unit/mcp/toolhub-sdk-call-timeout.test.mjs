/**
 * The resolver's per-call timeout must come from the server config, not the SDK.
 *
 * ⚠️ Regression this guards: the pre-SDK hand-rolled client defaulted every
 * request to `this.server.requestTimeoutMs` (120 s for every server in
 * `$PA_REPO/.mcp.json`). The P3a migration onto `@modelcontextprotocol/client`
 * dropped that default, so the SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 000 ms)
 * silently took over — measurably rejecting a 65 s call at 60.0 s against a
 * server configured for 120 s.
 *
 * The test discriminates on TIME, because the timeout is client-side and
 * invisible to the server: the fixture answers `tools/call` after a delay
 * longer than the configured timeout but far shorter than the SDK default.
 * Before the fix the call therefore SUCCEEDS (the assertion's expected
 * rejection is missing); after it the call is rejected at ~the configured value.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";

const PROTOCOL = "2026-07-28";
const TOOL_NAME = "perplexity_research";

/** A minimal 2026-07-28 (stateless) MCP fixture whose `tools/call` is slow. */
async function startSlowToolFixture({ delayMs }) {
  const observed = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      observed.push({ method: body.method, at: Date.now() });

      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };

      if (body.method === "server/discover") {
        reply({
          resultType: "complete",
          supportedVersions: [PROTOCOL],
          capabilities: { tools: {} }
        });
        return;
      }
      if (body.method === "tools/list") {
        reply({
          resultType: "complete",
          tools: [{ name: TOOL_NAME, inputSchema: { type: "object", properties: { input: { type: "string" } } } }]
        });
        return;
      }
      if (body.method === "tools/call") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        reply({
          resultType: "complete",
          content: [{ type: "text", text: "SLOW ANSWER" }]
        });
        return;
      }
      reply({ resultType: "complete" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    observed,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function makeServerConfig(overrides) {
  return {
    name: "perplexity",
    transport: "streamable-http",
    url: "http://127.0.0.1:1/mcp",
    protocolEra: "2026-07-28",
    requestTimeoutMs: 120_000,
    startupTimeoutMs: 30_000,
    headers: {},
    ...overrides
  };
}

/**
 * The known-good control. Without it, a fixture that simply cannot connect would
 * make the discriminating test below "pass" for the wrong reason.
 */
test("a call that finishes inside the configured timeout still succeeds", async () => {
  const fixture = await startSlowToolFixture({ delayMs: 50 });
  const adapter = new HttpMcpSdkAdapter(
    makeServerConfig({ url: fixture.url, requestTimeoutMs: 1200 }),
    (value) => value
  );
  try {
    const result = await adapter.callTool(TOOL_NAME, { input: "q" });
    assert.equal(result.content[0].text, "SLOW ANSWER");
    assert.ok(
      fixture.observed.some((entry) => entry.method === "tools/call"),
      "the fixture must have served the call"
    );
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

test("a tool call is bounded by the server's configured requestTimeoutMs, not the SDK default", async () => {
  // 2 000 ms of work against a 1 200 ms configured timeout. The SDK default is
  // 60 000 ms, so before the fix this call RESOLVES and the expected rejection
  // never happens.
  const fixture = await startSlowToolFixture({ delayMs: 2000 });
  const adapter = new HttpMcpSdkAdapter(
    makeServerConfig({ url: fixture.url, requestTimeoutMs: 1200 }),
    (value) => value
  );
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => adapter.callTool(TOOL_NAME, { input: "q" }),
      (error) => {
        assert.equal(error?.code, "REQUEST_TIMEOUT", `expected a request timeout, got ${error?.code}: ${error?.message}`);
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 1900,
      `the call must abort at the configured 1200 ms, not the SDK's 60 s default; it took ${elapsed} ms`
    );
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
