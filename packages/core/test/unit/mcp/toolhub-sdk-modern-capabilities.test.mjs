/**
 * A pinned-modern connection must learn the server's REAL capabilities.
 *
 * ⚠️ Regression this guards: the pinned branch used to connect with
 * `{ prior: { kind: "modern", discover: { …, capabilities: { tools: {} } } } }`.
 * A `prior` is an *assertion*, not a probe — SDK 2.3.1 `dist/index.mjs:3471-3479`
 * never sends `server/discover` on that path and takes the caller's literal
 * `capabilities` as the server's own. So `getServerCapabilities()` returned
 * `{ tools: {} }` for **every** `protocolEra: "2026-07-28"` server, and anything
 * gated on a capability the server advertises — the Tasks extension this fleet
 * declares, and any future such feature — silently did nothing.
 *
 * The guard is deliberately direct: it asserts what the server advertised is what
 * the client can see, AND that a `server/discover` was actually exchanged. The
 * second half is what stops the test passing for the wrong reason.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";
import { TASKS_EXTENSION_ID } from "@ccr/core/mcp/protocol-era";

const PROTOCOL = "2026-07-28";
const TOOL_NAME = "perplexity_research";

async function startFixture() {
  const methods = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      methods.push(body.method);
      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };
      if (body.method === "server/discover") {
        reply({
          resultType: "complete",
          supportedVersions: [PROTOCOL],
          capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID]: {} } }
        });
        return;
      }
      if (body.method === "initialize") {
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" }
        });
        return;
      }
      if (body.method === "tools/list") {
        reply({
          resultType: "complete",
          // A 2026-07-28 cacheable result carries required ttlMs + cacheScope;
          // the SDK's wire schema rejects the result outright without them.
          ttlMs: 0,
          cacheScope: "public",
          tools: [{ name: TOOL_NAME, inputSchema: { type: "object", properties: { input: { type: "string" } } } }]
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
    methods,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function makeServerConfig(overrides) {
  return {
    name: "perplexity",
    transport: "streamable-http",
    url: "http://127.0.0.1:1/mcp",
    protocolEra: "2026-07-28",
    requestTimeoutMs: 30_000,
    startupTimeoutMs: 30_000,
    headers: {},
    ...overrides
  };
}

test("a pinned-modern connection exposes the capabilities the server actually advertised", async () => {
  const fixture = await startFixture();
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value);
  try {
    await adapter.listTools();
    assert.ok(
      fixture.methods.includes("server/discover"),
      `a pinned-modern connect must probe the server; methods seen: ${JSON.stringify(fixture.methods)}`
    );
    const capabilities = adapter.sdkClient.getServerCapabilities();
    assert.deepEqual(
      capabilities?.extensions?.[TASKS_EXTENSION_ID],
      {},
      `the server's advertised extension must be visible to the client, got ${JSON.stringify(capabilities)}`
    );
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

test("a legacy-era connection still performs the plain handshake and never probes", async () => {
  const fixture = await startFixture();
  const adapter = new HttpMcpSdkAdapter(
    makeServerConfig({ url: fixture.url, protocolEra: "legacy" }),
    (value) => value
  );
  try {
    await adapter.listTools();
    assert.ok(
      fixture.methods.includes("initialize"),
      `legacy must handshake via initialize; methods seen: ${JSON.stringify(fixture.methods)}`
    );
    assert.ok(
      !fixture.methods.includes("server/discover"),
      `legacy must not probe; methods seen: ${JSON.stringify(fixture.methods)}`
    );
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
