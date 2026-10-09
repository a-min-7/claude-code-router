/**
 * Legacy-era wire parity — the property the 2026-10-09 A/B measured, pinned so it cannot drift.
 *
 * ⚠️ Why this exists at all: this repo has got "legacy is byte-identical" **wrong once already**.
 * The P3c record says a prior era change claimed legacy parity and the claim was false — the
 * pre-P3a bundle sent *no* `mcp-protocol-version` header on post-`initialize` requests while the
 * SDK-based client sent `2025-11-25`. `:8212` accepts both, so nothing broke, which is exactly why
 * it sat unnoticed.
 *
 * The 2026-10-09 A/B established the current answer at the wire, against the real brave-search
 * backend, by diffing canonical request sequences from the pre-change and post-change bundles:
 * identical — no `server/discover`, no `tasks/*`, no `_meta`, no `Mcp-Method`/`Mcp-Name` on any
 * legacy request. This test pins that shape so a future change has to *break a test* rather than
 * silently break the fleet.
 *
 * It is a **pin, not a discriminator**: it passes against the source it was written on, and its
 * value is demonstrated by mutation (make the legacy branch probe, and the parity assertions fail).
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";

const LEGACY_PROTOCOL = "2024-11-05";
const MODERN_PROTOCOL = "2026-07-28";
const TOOL_NAME = "brave_web_search";
const ANSWER = "LEGACY ANSWER";

/**
 * A legacy-era fixture that records **everything** the resolver puts on the wire, including the
 * headers a modern-era server would require. Nothing modern may appear on a legacy connection.
 */
async function startLegacyFixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          /* keep {} */
        }
      }

      requests.push({
        method: body.method,
        protocolVersion: req.headers["mcp-protocol-version"] ?? null,
        mcpMethod: req.headers["mcp-method"] ?? null,
        mcpName: req.headers["mcp-name"] ?? null,
        hasSessionId: Boolean(req.headers["mcp-session-id"]),
        hasParamsMeta: Boolean(body?.params?._meta)
      });

      // Legacy handshake: `serverInfo` is required on the InitializeResult — the SDK's schema
      // rejects the result without it, and the failure reads as a connection error rather than
      // a malformed fixture.
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "legacy-session-1" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: LEGACY_PROTOCOL,
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-fixture", version: "1.0.0" }
            }
          })
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end("");
        return;
      }
      if (body.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: TOOL_NAME,
                  description: "legacy fixture tool",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } }
                }
              ]
            }
          })
        );
        return;
      }
      if (body.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: ANSWER }] }
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result: {} }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    methodsSeen: () => requests.map((entry) => entry.method),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function makeServerConfig(overrides) {
  return {
    name: "brave-search",
    transport: "streamable-http",
    url: "http://127.0.0.1:1/mcp",
    protocolEra: "legacy",
    requestTimeoutMs: 30_000,
    startupTimeoutMs: 30_000,
    headers: {},
    ...overrides
  };
}

test("a legacy backend is driven entirely in its own era — never probed, never sent modern vocabulary", async () => {
  const fixture = await startLegacyFixture();
  // Mirror production's normalizer (toolhub-mcp.ts extracts `.tools`) — passing identity here
  // returns the SDK result object rather than the array.
  const adapter = new HttpMcpSdkAdapter(makeServerConfig({ url: fixture.url }), (value) => value?.tools ?? []);
  try {
    const tools = await adapter.listTools();
    assert.equal(tools[0]?.name, TOOL_NAME, "the legacy catalogue must come back");

    const result = await adapter.callTool(TOOL_NAME, { query: "anything" });
    assert.equal(result.content[0].text, ANSWER, "the legacy call leg must complete over its own transport");

    const seen = fixture.methodsSeen();
    assert.ok(seen.includes("initialize"), `legacy must handshake via initialize; saw ${JSON.stringify(seen)}`);

    // ⚠️ The one that has actually broken before: a legacy server must never be probed. An era
    // change that made this connection probe would send `server/discover` here and nowhere obvious.
    assert.ok(
      !seen.includes("server/discover"),
      `a legacy connection must not probe; saw ${JSON.stringify(seen)}`
    );
    assert.ok(seen.includes("tools/list"), "the catalogue leg ran");
    assert.ok(seen.includes("tools/call"), "the call leg ran");

    // Modern-only vocabulary must be absent from EVERY legacy request, not just the handshake.
    for (const entry of fixture.requests) {
      assert.equal(entry.mcpMethod, null, `Mcp-Method is modern-only, sent on ${entry.method}`);
      assert.equal(entry.mcpName, null, `Mcp-Name is modern-only, sent on ${entry.method}`);
      assert.equal(entry.hasParamsMeta, false, `params._meta is the 2026-07-28 envelope, sent on ${entry.method}`);
      assert.notEqual(
        entry.protocolVersion,
        MODERN_PROTOCOL,
        `a legacy request carried the modern protocol version on ${entry.method}`
      );
    }
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
