/**
 * The config → adapter era seam.
 *
 * P3b shipped the per-server era vocabulary behind a green 644-line suite
 * (`toolhub-sdk-era.test.mjs`) and the feature still never reached the wire.
 * The config surface names the field `protocolVersion`; the SDK adapters read
 * `protocolEra`; nothing mapped the two, so every server silently resolved to
 * `"legacy"` and an era change looked like "the config didn't take" — pointing
 * at the wrong thing entirely.
 *
 * `toolhub-sdk-era.test.mjs` could not catch that, because it builds server
 * configs with `protocolEra:` directly and exercises the adapter in isolation.
 * It never drives the shape the gateway actually sends.
 *
 * These tests drive that shape: the exact object the gateway puts into
 * `TOOLHUB_MCP_SERVERS_JSON`, through `normalizeServerConfig`, into an adapter.
 *
 * A green suite tells you the assertions held — not that they were pointed at
 * the seam. This file is the pointer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerConfig } from "@ccr/core/mcp/toolhub-server-config.ts";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";

// Captured 2026-10-08 from the live resolver process on Emmy, out of its own
// environment (`ps eww -p <pid>` → TOOLHUB_MCP_SERVERS_JSON). This is the shape
// `toolHubBackendServers()` produces and the gateway hands the resolver.
// Its keys are the point: `protocolVersion`, and no `protocolEra`.
const LIVE_PERPLEXITY_ENTRY = {
  headers: {},
  name: "perplexity",
  protocolVersion: "2024-11-05",
  requestTimeoutMs: 30000,
  startupTimeoutMs: 600000,
  transport: "streamable-http",
  url: "http://localhost:8212/mcp"
};

const entry = (overrides) => ({ ...LIVE_PERPLEXITY_ENTRY, ...overrides });
const noTools = () => [];

// ── The seam itself ───────────────────────────────────────────────────

test("normalizeServerConfig resolves the era from the config's protocolVersion", () => {
  assert.equal(normalizeServerConfig(entry({ protocolVersion: "2026-07-28" })).protocolEra, "2026-07-28");
  assert.equal(normalizeServerConfig(entry({ protocolVersion: "auto" })).protocolEra, "auto");
  assert.equal(normalizeServerConfig(entry({ protocolVersion: "legacy" })).protocolEra, "legacy");
  // The literal the configs started on is an alias for legacy, not an era of its own.
  assert.equal(normalizeServerConfig(entry({ protocolVersion: "2024-11-05" })).protocolEra, "legacy");
});

test("the captured live entry still resolves to legacy", () => {
  const normalized = normalizeServerConfig(LIVE_PERPLEXITY_ENTRY);
  assert.equal(normalized.protocolEra, "legacy");
  assert.equal(normalized.transport, "streamable-http");
  assert.equal(normalized.url, "http://localhost:8212/mcp");
});

test("an entry with no protocolVersion defaults to legacy", () => {
  const { protocolVersion, ...withoutEra } = LIVE_PERPLEXITY_ENTRY;
  assert.equal(normalizeServerConfig(withoutEra).protocolEra, "legacy");
});

test("the mapping does not depend on the transport", () => {
  const stdio = normalizeServerConfig({
    command: "node",
    name: "some-stdio-server",
    protocolVersion: "2026-07-28",
    transport: "stdio"
  });
  assert.equal(stdio.protocolEra, "2026-07-28");
});

// ── Config → adapter, end of the seam ─────────────────────────────────

test("config → adapter: a modern-era entry yields modern prior discovery", () => {
  const adapter = new HttpMcpSdkAdapter(
    normalizeServerConfig(entry({ protocolVersion: "2026-07-28" })),
    noTools
  );
  const prior = adapter.priorDiscovery();
  assert.equal(prior.kind, "modern");
  assert.ok(prior.discover.supportedVersions.includes("2026-07-28"));
});

test("config → adapter: the live legacy entry yields legacy prior discovery", () => {
  const adapter = new HttpMcpSdkAdapter(normalizeServerConfig(LIVE_PERPLEXITY_ENTRY), noTools);
  assert.equal(adapter.priorDiscovery().kind, "legacy");
});
