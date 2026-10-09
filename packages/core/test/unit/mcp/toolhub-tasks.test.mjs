/**
 * MCP Tasks (SEP-2663) in the resolver.
 *
 * ⚠️ The regression these guard: CCR declares the Tasks extension to every
 * backend server, so a server MAY answer `tools/call` with
 * `resultType: "task"` — and the SDK cannot decode one. Measured against
 * `@modelcontextprotocol/client` 2.3.1: `callTool()` rejects with
 * `UnsupportedResultType`, and the explicit-schema `request()` path rejects
 * identically, so before this work `perplexity_research` failed outright and the
 * answer was lost.
 *
 * The fixture is deliberately **strict**: it rejects (HTTP 400) any request
 * missing one of the four things a 2026-07-28 server requires —
 * `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (sourced per method, mirroring
 * rmcp's `NAME_FROM_NAME`/`NAME_FROM_TASK_ID` table) and `params._meta`. A green
 * run therefore proves the client sent them, rather than assuming it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { HttpMcpSdkAdapter } from "@ccr/core/mcp/toolhub-sdk-adapters.ts";
import { TASKS_EXTENSION_ID } from "@ccr/core/mcp/protocol-era";
import { serverAdvertisesTasks, taskDeadlineMs, TASK_DEADLINE_LIMITS } from "@ccr/core/mcp/toolhub-tasks.ts";

const PROTOCOL = "2026-07-28";
const TOOL_NAME = "perplexity_research";
const TASK_ID = "task-from-the-fixture";
const ANSWER = "BACKGROUND ANSWER";

/** rmcp's own SEP-2243 table: which param `Mcp-Name` is sourced from. */
function nameSource(method) {
  switch (method) {
    case "tools/call":
    case "prompts/get":
      return "name";
    case "resources/read":
    case "resources/subscribe":
    case "resources/unsubscribe":
      return "uri";
    case "tasks/get":
    case "tasks/update":
    case "tasks/cancel":
      return "taskId";
    default:
      return undefined;
  }
}

/**
 * A 2026-07-28 (stateless) MCP fixture.
 *
 * @param advertiseTasks  whether `server/discover` advertises the extension
 * @param toolBehaviour   "task" | "plain" — what `tools/call` answers with
 * @param taskStatus      what `tasks/get` reports for the task
 * @param ttlMs           the task's advertised TTL (drives the deadline)
 */
async function startFixture({
  advertiseTasks = true,
  toolBehaviour = "task",
  taskStatus = "completed",
  ttlMs = 600_000,
  /** Deliberately non-conforming: task a client even though we never advertised. */
  forceTask = false
} = {}) {
  const requests = [];
  const violations = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      requests.push({ method: body.method, mcpMethod: req.headers["mcp-method"], mcpName: req.headers["mcp-name"] });

      // Enforce the stateless contract exactly as the real server does.
      const problems = [];
      if (req.headers["mcp-protocol-version"] !== PROTOCOL) problems.push("MCP-Protocol-Version");
      if (!req.headers["mcp-method"]) problems.push("Mcp-Method");
      const meta = body?.params?._meta;
      if (!meta || meta["io.modelcontextprotocol/protocolVersion"] !== PROTOCOL) problems.push("params._meta");
      const key = nameSource(body.method);
      if (key !== undefined && typeof body?.params?.[key] === "string" && req.headers["mcp-name"] !== body.params[key]) {
        problems.push(`Mcp-Name(${key})`);
      }
      if (problems.length) {
        violations.push({ method: body.method, problems });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32020, message: `missing required: ${problems.join(", ")}` }
          })
        );
        return;
      }

      const declared = Boolean(
        meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[TASKS_EXTENSION_ID]
      );
      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };
      const now = new Date().toISOString();

      switch (body.method) {
        case "server/discover":
          reply({
            resultType: "complete",
            supportedVersions: [PROTOCOL],
            capabilities: { tools: {}, ...(advertiseTasks ? { extensions: { [TASKS_EXTENSION_ID]: {} } } : {}) }
          });
          return;
        case "tools/list":
          reply({
            resultType: "complete",
            tools: [{ name: TOOL_NAME, inputSchema: { type: "object", properties: { input: { type: "string" } } } }]
          });
          return;
        case "tools/call":
          // A conforming server only returns a task when it advertised the
          // extension AND the client declared it (SEP-2663, server step 2).
          if (toolBehaviour === "task" && declared && (advertiseTasks || forceTask)) {
            reply({
              resultType: "task",
              taskId: TASK_ID,
              status: "working",
              createdAt: now,
              lastUpdatedAt: now,
              ttlMs,
              pollIntervalMs: 50
            });
            return;
          }
          reply({ resultType: "complete", content: [{ type: "text", text: "PLAIN ANSWER" }] });
          return;
        case "tasks/get":
          if (taskStatus === "completed") {
            reply({
              resultType: "complete",
              taskId: TASK_ID,
              status: "completed",
              createdAt: now,
              lastUpdatedAt: now,
              ttlMs,
              result: { resultType: "complete", content: [{ type: "text", text: ANSWER }] }
            });
            return;
          }
          reply({ resultType: "complete", taskId: TASK_ID, status: "working", createdAt: now, lastUpdatedAt: now, ttlMs });
          return;
        case "tasks/cancel":
          reply({ resultType: "complete", taskId: TASK_ID, status: "cancelled", createdAt: now, lastUpdatedAt: now });
          return;
        default:
          reply({ resultType: "complete" });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    violations,
    countOf: (method) => requests.filter((entry) => entry.method === method).length,
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

async function withAdapter(config, run) {
  const adapter = new HttpMcpSdkAdapter(config, (value) => value);
  try {
    return await run(adapter);
  } finally {
    await adapter.close();
  }
}

// ── The advertisement gate ────────────────────────────────────────────

test("serverAdvertisesTasks requires the modern era and the exact empty-object declaration", () => {
  const modern = (capabilities) => ({ getProtocolEra: () => "modern", getServerCapabilities: () => capabilities });
  assert.equal(serverAdvertisesTasks(modern({ extensions: { [TASKS_EXTENSION_ID]: {} } })), true);
  assert.equal(serverAdvertisesTasks(modern({ extensions: {} })), false, "no declaration");
  assert.equal(serverAdvertisesTasks(modern({})), false, "no extensions map");
  assert.equal(
    serverAdvertisesTasks(modern({ extensions: { [TASKS_EXTENSION_ID]: { unexpected: true } } })),
    false,
    "ext-tasks downgrades a non-empty declaration, so the gate must refuse it too"
  );
  assert.equal(serverAdvertisesTasks({ getProtocolEra: () => "legacy", getServerCapabilities: () => ({}) }), false, "legacy era");
});

test("taskDeadlineMs stops one request short of the task TTL and is capped", () => {
  assert.equal(taskDeadlineMs(600_000), 600_000 - TASK_DEADLINE_LIMITS.headroomMs);
  assert.equal(taskDeadlineMs(60_000_000), TASK_DEADLINE_LIMITS.hardMaxMs, "capped, however long the TTL");
  assert.equal(taskDeadlineMs(null), TASK_DEADLINE_LIMITS.hardMaxMs, "unlimited retention falls back to the ceiling");
  assert.equal(taskDeadlineMs(undefined), TASK_DEADLINE_LIMITS.hardMaxMs);
  assert.ok(taskDeadlineMs(500) >= 1, "a TTL shorter than the headroom still yields a positive deadline");
});

// ── The behaviour the whole change exists for ─────────────────────────

test("a task-returning server yields the task's final result, not a failure", async () => {
  const fixture = await startFixture({ toolBehaviour: "task", taskStatus: "completed" });
  try {
    const result = await withAdapter(makeServerConfig({ url: fixture.url }), (adapter) =>
      adapter.callTool(TOOL_NAME, { input: "q" })
    );
    assert.deepEqual(fixture.violations, [], "every request must satisfy the stateless contract");
    assert.equal(result.content[0].text, ANSWER, "the polled result must come back lifted, without resultType");
    assert.equal(result.resultType, undefined, "the wire-only discriminator is stripped, as callTool does");
    assert.ok(fixture.countOf("tasks/get") >= 1, "the task must have been polled");
  } finally {
    await fixture.close();
  }
});

test("a server that never returns a task keeps the plain path — and is never polled", async () => {
  // Advertises the extension (so a runtime IS attached) but answers normally.
  const fixture = await startFixture({ advertiseTasks: true, toolBehaviour: "plain" });
  try {
    const result = await withAdapter(makeServerConfig({ url: fixture.url }), (adapter) =>
      adapter.callTool(TOOL_NAME, { input: "q" })
    );
    assert.deepEqual(fixture.violations, []);
    assert.equal(result.content[0].text, "PLAIN ANSWER");
    assert.equal(fixture.countOf("tasks/get"), 0, "no task was created, so nothing may be polled");
  } finally {
    await fixture.close();
  }
});

test("a server that does not advertise the extension gets no task runtime at all", async () => {
  const fixture = await startFixture({ advertiseTasks: false, toolBehaviour: "task" });
  try {
    const result = await withAdapter(makeServerConfig({ url: fixture.url }), (adapter) =>
      adapter.callTool(TOOL_NAME, { input: "q" })
    );
    assert.deepEqual(fixture.violations, []);
    assert.equal(result.content[0].text, "PLAIN ANSWER");
    assert.equal(fixture.countOf("tasks/get"), 0, "nothing may be polled for a non-advertising server");
  } finally {
    await fixture.close();
  }
});

test("a non-advertising server that returns a task anyway fails loudly rather than being polled", async () => {
  // A protocol violation. We must not paper over it by silently polling a task
  // the server was never entitled to create — the failure is the correct
  // outcome, and it must be a failure rather than a hang.
  const fixture = await startFixture({ advertiseTasks: false, toolBehaviour: "task", forceTask: true });
  try {
    await assert.rejects(
      () => withAdapter(makeServerConfig({ url: fixture.url }), (adapter) => adapter.callTool(TOOL_NAME, { input: "q" })),
      (error) => {
        assert.equal(error?.code, "UNSUPPORTED_RESULT_TYPE", `expected the SDK's decode failure, got ${error?.code}`);
        return true;
      }
    );
    assert.equal(fixture.countOf("tasks/get"), 0);
  } finally {
    await fixture.close();
  }
});

// ── Bounds ────────────────────────────────────────────────────────────

test("a task that never settles is abandoned at its TTL and cancelled remotely", async () => {
  // ttlMs 2 000 ⇒ a 1 000 ms deadline, so this test costs about a second.
  const fixture = await startFixture({ toolBehaviour: "task", taskStatus: "working", ttlMs: 2_000 });
  try {
    await assert.rejects(
      () => withAdapter(makeServerConfig({ url: fixture.url }), (adapter) => adapter.callTool(TOOL_NAME, { input: "q" })),
      (error) => {
        assert.ok(error instanceof Error, `expected an error, got ${String(error)}`);
        return true;
      }
    );
    assert.ok(fixture.countOf("tasks/get") >= 1, "it must have polled before giving up");
    assert.equal(fixture.countOf("tasks/cancel"), 1, "giving up must cancel the task, not orphan it");
  } finally {
    await fixture.close();
  }
});
