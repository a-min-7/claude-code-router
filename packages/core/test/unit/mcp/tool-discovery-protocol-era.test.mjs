import assert from "node:assert/strict";
import test from "node:test";
import { resolveProtocolEra, resolveWireProtocolVersion } from "@ccr/core/mcp/protocol-era.ts";

// Byte-identical test for P1: a legacy server must emit the same header value
// as today.  Merging P1 must change nothing until someone opts in.

test("resolveProtocolEra normalises legacy input strings", () => {
  assert.equal(resolveProtocolEra(undefined), "legacy");
  assert.equal(resolveProtocolEra("2024-11-05"), "legacy");
  assert.equal(resolveProtocolEra("legacy"), "legacy");
});

test("resolveProtocolEra passes through auto and modern", () => {
  assert.equal(resolveProtocolEra("auto"), "auto");
  assert.equal(resolveProtocolEra("2026-07-28"), "2026-07-28");
});

test("resolveProtocolEra fails open on unknown values", () => {
  assert.equal(resolveProtocolEra("anything-else"), "legacy");
  assert.equal(resolveProtocolEra(""), "legacy");
});

test("resolveWireProtocolVersion emits byte-identical legacy header", () => {
  // This is the safety property: legacy-era servers produce the same
  // `MCP-Protocol-Version` header value they always did.
  assert.equal(resolveWireProtocolVersion("legacy"), "2024-11-05");
  assert.equal(resolveWireProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(resolveWireProtocolVersion(""), "2024-11-05");
  assert.equal(resolveWireProtocolVersion(undefined), "2024-11-05");
});
