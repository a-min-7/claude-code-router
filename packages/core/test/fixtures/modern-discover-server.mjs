#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// Test fixture: a minimal MCP server that advertises supportedVersions:
// ["2026-07-28"] when it receives a server/discover request.
//
// Modeled on pi-mcp-adapter's __tests__/fixtures/modern-discover-server.mjs.
// ──────────────────────────────────────────────────────────────────────────────

import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function reject(id, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message },
  })}\n`);
}

lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    respond(request.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "modern-discover",
          version: "1.0.0",
        },
      },
    });
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "modern-discover", version: "1.0.0" },
    });
    return;
  }
  if (request.id !== undefined) {
    reject(request.id, "Method not found");
  }
});
