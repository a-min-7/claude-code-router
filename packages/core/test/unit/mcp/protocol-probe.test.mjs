import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolEraCache, probeProtocolEra } from "@ccr/core/mcp/protocol-probe.ts";
import { MODERN_PROTOCOL_VERSION } from "@ccr/core/mcp/protocol-era.ts";

// ── ProtocolEraCache tests ─────────────────────────────────────────────────

test("cache returns undefined for unknown key", () => {
  const cache = new ProtocolEraCache(1000);
  assert.equal(cache.get("http://unknown"), undefined);
});

test("cache stores and returns era", () => {
  const cache = new ProtocolEraCache(10_000);
  cache.set("http://example.test", "2026-07-28");
  assert.equal(cache.get("http://example.test"), "2026-07-28");
});

test("cache returns legacy after expiry", async () => {
  const cache = new ProtocolEraCache(50);
  cache.set("http://expire.test", "2026-07-28");
  assert.equal(cache.get("http://expire.test"), "2026-07-28");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cache.get("http://expire.test"), undefined);
});

test("cache invalidation clears all entries", () => {
  const cache = new ProtocolEraCache(10_000);
  cache.set("http://a.test", "legacy");
  cache.set("http://b.test", "2026-07-28");
  cache.invalidate();
  assert.equal(cache.get("http://a.test"), undefined);
  assert.equal(cache.get("http://b.test"), undefined);
});

// ── probeProtocolEra tests (mocked fetch) ───────────────────────────────────

// Capture the original fetch so we can replace it.
const origFetch = globalThis.fetch;

function mockFetch(...responses) {
  globalThis.fetch = async (...args) => {
    const res = responses.shift();
    if (!res) {
      globalThis.fetch = origFetch;
      throw new Error("no more mock responses");
    }
    return res;
  };
}

function restoreFetch() {
  globalThis.fetch = origFetch;
}

test("modern server returning supportedVersions resolves to 2026-07-28", async () => {
  const jsonResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    },
  });

  mockFetch(
    new Response(jsonResponse, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await probeProtocolEra("http://modern.test/mcp");
  assert.equal(result.era, "2026-07-28");
  assert.ok(result.detail.includes("2026-07-28"));
  restoreFetch();
});

test("legacy server responding to server/discover with error falls back to initialize", async () => {
  // server/discover returns 404 (method not found), then initialize succeeds.
  const initResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-server", version: "1.0.0" },
    },
  });

  mockFetch(
    new Response("Not Found", { status: 404 }),
    new Response(initResponse, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await probeProtocolEra("http://legacy.test/mcp");
  assert.equal(result.era, "legacy");
  restoreFetch();
});

test("probe returns legacy when server declines both discover and initialize", async () => {
  mockFetch(
    new Response("Not Found", { status: 404 }),
    new Response("Not Found", { status: 404 }),
  );

  const result = await probeProtocolEra("http://stubborn.test/mcp");
  assert.equal(result.era, "legacy");
  assert.ok(result.detail.includes("inconclusive"));
  restoreFetch();
});

test("probe returns legacy on 503 (unrecoverable error)", async () => {
  mockFetch(
    new Response("Service Unavailable", { status: 503 }),
  );

  const result = await probeProtocolEra("http://unreachable.test/mcp");
  assert.equal(result.era, "legacy");
  assert.ok(result.detail.includes("503"));
  restoreFetch();
});

test("probe returns legacy when server accepts discover but doesn't advertise modern", async () => {
  const jsonResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    },
  });

  mockFetch(
    new Response(jsonResponse, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await probeProtocolEra("http://legacy-accepts.test/mcp");
  assert.equal(result.era, "legacy");
  restoreFetch();
});

test("probe returns legacy on network error", async () => {
  // Simulate a network failure by throwing from fetch.
  globalThis.fetch = async () => {
    throw new Error("ENOTFOUND");
  };

  const result = await probeProtocolEra("http://unreachable.test/mcp");
  assert.equal(result.era, "legacy");
  assert.ok(result.detail.includes("probe failed") || result.detail.includes("ENOTFOUND"));
  restoreFetch();
});
