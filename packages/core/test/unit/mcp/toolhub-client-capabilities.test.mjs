/**
 * The resolver's declared client capabilities.
 *
 * ⚠️ This pins a **wire shape**, not a local detail. rmcp's server decides whether it may answer
 * `tools/call` with a task handle by checking
 * `ClientCapabilities::supports_tasks()` — `extensions.contains_key("io.modelcontextprotocol/tasks")`.
 * The `2026-07-28` era moved Tasks out of core into a named extension, so the declaration lives at
 * `capabilities.extensions[id]`. The deprecated `2025-11-25` form is a `capabilities.tasks` key,
 * which `@modelcontextprotocol/client` still models — and a server would ignore it in silence.
 *
 * Verified against a real capture 2026-10-09: the deployed resolver sends
 * `_meta["io.modelcontextprotocol/clientCapabilities"] = {"extensions":{"io.modelcontextprotocol/tasks":{}}}`
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  TASKS_EXTENSION_ID,
  toolHubClientCapabilities
} from "@ccr/core/mcp/protocol-era";

test("the tasks extension id matches the one servers check for", () => {
  assert.equal(TASKS_EXTENSION_ID, "io.modelcontextprotocol/tasks");
});

test("the capability is declared as an extension, not the deprecated core key", () => {
  const caps = toolHubClientCapabilities();

  assert.ok(caps.extensions, "the extension map must be present");
  assert.ok(
    TASKS_EXTENSION_ID in caps.extensions,
    "the tasks extension must be declared under its own id"
  );
  assert.deepEqual(
    caps.extensions[TASKS_EXTENSION_ID],
    {},
    "rmcp's enable_tasks inserts an EMPTY object; a non-empty one is a different shape"
  );
  assert.equal(
    "tasks" in caps,
    false,
    "the deprecated 2025-11-25 `capabilities.tasks` key must NOT be used — a server checks the " +
      "extension map, so this would be ignored silently"
  );
});

/**
 * ⚠️ **Known gap, deliberately not guarded here.** Nothing asserts that all three adapters (SSE,
 * Streamable-HTTP, stdio) actually *call* `toolHubClientCapabilities()` — only that the builder's
 * shape is right. A source-level check was written and removed: it resolved the adapter file via
 * `new URL(..., import.meta.url)`, and esbuild rewrites `import.meta.url` when bundling the test,
 * so it failed with `ERR_INVALID_URL` rather than reading anything. The alternative — a path off
 * `process.cwd()` — differs between `npm run test:unit` invocations, which is the same
 * default-path fragility that has already produced green-for-the-wrong-file runs in this fleet.
 *
 * The behaviour IS verified, just not by a test: a live capture on 2026-10-09 confirmed the
 * deployed resolver sends `_meta["io.modelcontextprotocol/clientCapabilities"] =
 * {"extensions":{"io.modelcontextprotocol/tasks":{}}}`. Re-run that capture after touching any
 * `capabilities:` declaration in `toolhub-sdk-adapters.ts`.
 */
