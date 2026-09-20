import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionPlanArgs,
  buildExecutionPlanJs,
  buildSequentialExecutionPlanJs,
  getSchemaRequiredProperties,
  isBrowserAutomationTool,
  repairSketchArguments,
  isBrowserNavigationTool,
  toIdentifier,
  toPlanVariableName
} from "@ccr/core/mcp/toolhub-plan.ts";

/**
 * Characterisation tests for the resolve step's dependency-plan builders.
 *
 * The defect that motivated extracting this module: **a `workflowSketch` was
 * returned verbatim and was never checked against the tool's `inputSchema`**,
 * so a sketch that flattened a tool's arguments to the top level reached the
 * client as-is. The live failure: asked to plan a call to
 * `deepseek_chat_completion`, the resolver emitted `{ messages, reasoning_effort }`
 * at the top level, omitting the `params` wrapper the schema requires — even
 * though the args type it was handed declared `params` as required.
 *
 * `repairSketchArguments` now re-wraps exactly those calls. The tests below pin
 * the repair and, just as deliberately, its boundaries: everything it cannot
 * read confidently must come back byte-identical.
 */

/** A minimal well-formed entry; the schema is opt-in per test. */
function tool(overrides = {}) {
  return {
    toolName: "mcp.deepseek.deepseek_chat_completion",
    remoteToolName: "deepseek_chat_completion",
    serverId: "deepseek",
    serverName: "deepseek",
    serverNamespace: "deepseek",
    ...overrides
  };
}

/** The schema shape this server's tools use: one required free-form object. */
const ENVELOPE_SCHEMA = {
  type: "object",
  required: ["params"],
  properties: { params: { additionalProperties: true, type: "object" } }
};

// ---------------------------------------------------------------------------
// The envelope pair: the schema-derived path and the repaired sketch path
// ---------------------------------------------------------------------------

const ENVELOPE_TOOL = [tool({ inputSchema: ENVELOPE_SCHEMA })];
const ENVELOPE_CALL = `callTool("mcp.deepseek.deepseek_chat_completion", `;

test("the schema-derived path emits the required envelope key", () => {
  // The schema-aware builder gets this RIGHT — it reads `required`.
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: ENVELOPE_SCHEMA })), `{ "params": params }`);
});

test("the sketch path re-wraps arguments flattened out of the required envelope", () => {
  // The live failure, reproduced and repaired: the sketch flattens the
  // arguments, so the plan the client would execute violates the schema. The
  // repair nests them under `params`, and changes nothing else.
  const flattened = [
    "async function runWithToolHub() {",
    `  const step1 = await callTool("mcp.deepseek.deepseek_chat_completion", { messages: [], reasoning_effort: "ultra" });`,
    "}"
  ].join("\n");

  const plan = buildExecutionPlanJs(flattened, [tool({ inputSchema: ENVELOPE_SCHEMA })]);

  assert.equal(plan, [
    "async function runWithToolHub() {",
    `  const step1 = await callTool("mcp.deepseek.deepseek_chat_completion", { "params": { messages: [], reasoning_effort: "ultra" } });`,
    "}"
  ].join("\n"));
});

// ---------------------------------------------------------------------------
// The repair's boundaries
// ---------------------------------------------------------------------------

test("a sketch that already conforms is byte-identical", () => {
  for (const conforming of [
    `const r = ${ENVELOPE_CALL}{ "params": { messages: [] } });`,
    `const r = ${ENVELOPE_CALL}{ params: { messages: [], reasoning_effort: "ultra" } });`,
    `const r = ${ENVELOPE_CALL}{ params, trace: true });`,
    `const r = ${ENVELOPE_CALL}{ "params": {} });`
  ]) {
    assert.equal(repairSketchArguments(conforming, ENVELOPE_TOOL), conforming);
  }
});

test("nested objects, and braces inside strings, survive the repair intact", () => {
  const sketch = `const r = ${ENVELOPE_CALL}{ messages: [{ role: "user", content: "a } b" }], options: { nested: { deep: true }, quoted: '}' }, escaped: "\\"" });`;
  assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), `const r = ${ENVELOPE_CALL}{ "params": { messages: [{ role: "user", content: "a } b" }], options: { nested: { deep: true }, quoted: '}' }, escaped: "\\"" } });`);
});

test("braces inside a template literal, interpolated or not, survive the repair intact", () => {
  for (const args of [
    "{ query: `select { from } where x`, limit: 1 }",
    '{ query: `a ${ "}" } b`, limit: 1 }',
    '{ query: `${ { nested: "}" } }`, limit: 1 }'
  ]) {
    const sketch = `const r = ${ENVELOPE_CALL}${args});`;
    assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), `const r = ${ENVELOPE_CALL}{ "params": ${args} });`);
  }
});

test("a tool with anything other than one required object property is untouched", () => {
  const flattened = `const r = ${ENVELOPE_CALL}{ messages: [] });`;
  for (const schema of [
    undefined,
    {},
    { required: [] },
    { required: ["a", "b"], properties: { a: { type: "object" }, b: { type: "object" } } },
    { required: ["params"], properties: { params: { type: "string" } } },
    { required: ["params"], properties: { params: { type: "array" } } },
    { required: ["params"], properties: { other: { type: "object" } } },
    { required: ["params"] },
    { required: ["params", 1] }
  ]) {
    const tools = [tool({ inputSchema: schema })];
    assert.equal(repairSketchArguments(flattened, tools), flattened, `for ${JSON.stringify(schema)}`);
  }
});

test("an argument that is not a non-empty object literal is untouched", () => {
  for (const args of ["{}", "{ }", "someVar", '"a string"', "`a template`", "[1, 2]", "{ /* c */ }"]) {
    const sketch = `const r = ${ENVELOPE_CALL}${args});`;
    assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), sketch, `for ${args}`);
  }
});

test("a call whose tool name is not in selectedTools is untouched", () => {
  const sketch = `const r = callTool("mcp.other.tool", { messages: [] });`;
  assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), sketch);
  assert.equal(repairSketchArguments(sketch, []), sketch);
});

test("an argument object the scanner cannot close is left alone", () => {
  for (const sketch of [
    // Never closes at all.
    `const r = ${ENVELOPE_CALL}{ messages: [], options: { deep: 1 });`,
    // Closes, but not as this call's argument.
    `const r = ${ENVELOPE_CALL}{ messages: [] + ")" } + 1;`,
    // The `}` sits inside an unterminated string, so the object never closes.
    `const r = ${ENVELOPE_CALL}{ messages: "unterminated });`
  ]) {
    assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), sketch, `for ${sketch}`);
  }
});

test("only the offending call is repaired, and text outside it is preserved", () => {
  const sketch = [
    "async function runWithToolHub() {",
    "  // A comment mentioning callTool(\"mcp.deepseek.deepseek_chat_completion\", { messages: [] })",
    '  const literal = \'callTool("mcp.deepseek.deepseek_chat_completion", { messages: [] })\';',
    '  const step1 = await callTool("mcp.other.tool", { messages: [] });',
    `  const step2 = await callTool("mcp.deepseek.deepseek_chat_completion", { messages: [{ role: "user" }] });`,
    "}"
  ].join("\n");

  assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), [
    "async function runWithToolHub() {",
    "  // A comment mentioning callTool(\"mcp.deepseek.deepseek_chat_completion\", { messages: [] })",
    '  const literal = \'callTool("mcp.deepseek.deepseek_chat_completion", { messages: [] })\';',
    '  const step1 = await callTool("mcp.other.tool", { messages: [] });',
    `  const step2 = await callTool("mcp.deepseek.deepseek_chat_completion", { "params": { messages: [{ role: "user" }] } });`,
    "}"
  ].join("\n"));
});

test("a call nested inside another call's arguments is left alone", () => {
  const sketch = `const r = ${ENVELOPE_CALL}{ messages: [], wrapped: callTool("mcp.deepseek.deepseek_chat_completion", { messages: [] }) });`;
  const repaired = repairSketchArguments(sketch, ENVELOPE_TOOL);
  assert.equal(repaired, `const r = ${ENVELOPE_CALL}{ "params": { messages: [], wrapped: callTool("mcp.deepseek.deepseek_chat_completion", { messages: [] }) } });`);
  assert.equal((repaired.match(/"params"/g) ?? []).length, 1, "the nested call is not wrapped too");
});

test("a plan built from a sketch without a repairable call keeps its own text", () => {
  const sketch = "async function runWithToolHub() {\n  // nothing to repair\n}";
  assert.equal(buildExecutionPlanJs(sketch, ENVELOPE_TOOL), sketch);
});

// ---------------------------------------------------------------------------
// The sketch path
// ---------------------------------------------------------------------------

test("a sketch with nothing to repair is returned trimmed and otherwise untouched", () => {
  const sketch = "  async function runWithToolHub() { await callTool(\"x\", {}); }  ";
  assert.equal(buildExecutionPlanJs(sketch, []), sketch.trim());
});

test("an empty or whitespace-only sketch falls back to the sequential plan", () => {
  const t = tool();
  for (const empty of ["", "   ", "\n\t", undefined]) {
    assert.equal(buildExecutionPlanJs(empty, [t]), buildSequentialExecutionPlanJs([t]), `for ${JSON.stringify(empty)}`);
  }
});

test("a non-string sketch falls back rather than throwing", () => {
  const t = tool();
  assert.equal(buildExecutionPlanJs(42, [t]), buildSequentialExecutionPlanJs([t]));
  assert.equal(buildExecutionPlanJs(null, [t]), buildSequentialExecutionPlanJs([t]));
});

// ---------------------------------------------------------------------------
// The schema-derived sequential plan
// ---------------------------------------------------------------------------

test("no tools yields the ask-the-user plan", () => {
  assert.equal(
    buildSequentialExecutionPlanJs([]),
    ["async function runWithToolHub() {", "  // Ask the user for missing task details before invoking tools.", "}"].join("\n")
  );
});

test("one numbered step per tool, in selection order", () => {
  const plan = buildSequentialExecutionPlanJs([
    tool({ toolName: "mcp.deepseek.alpha", inputSchema: { required: ["a"] } }),
    tool({ toolName: "mcp.deepseek.beta", inputSchema: { required: ["b"] } })
  ]);
  assert.match(plan, /const step1 = await callTool\("mcp\.deepseek\.alpha", \{ "a": a \}\);/);
  assert.match(plan, /const step2 = await callTool\("mcp\.deepseek\.beta", \{ "b": b \}\);/);
  assert.equal(plan.indexOf("step1") < plan.indexOf("step2"), true, "order preserved");
});

test("the tool name is JSON-quoted, so a quote in a name cannot break the plan", () => {
  const plan = buildSequentialExecutionPlanJs([tool({ toolName: 'mcp.x.a"b', inputSchema: { required: ["a"] } })]);
  assert.match(plan, /callTool\("mcp\.x\.a\\"b"/);
});

// ---------------------------------------------------------------------------
// Argument placeholder synthesis
// ---------------------------------------------------------------------------

test("one placeholder per required key, keyed by the schema's own names", () => {
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["alpha", "beta"] } })), `{ "alpha": alpha, "beta": beta }`);
});

test("no required property yields an empty object", () => {
  for (const schema of [undefined, {}, { required: [] }, { required: "nope" }, { properties: { a: {} } }]) {
    assert.equal(buildExecutionPlanArgs(tool({ inputSchema: schema })), "{}", `for ${JSON.stringify(schema)}`);
  }
});

test("non-string required entries are ignored, not stringified into the plan", () => {
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["ok", 1, null, { a: 1 }] } })), `{ "ok": ok }`);
});

test("a required key that is a reserved word becomes the placeholder `value`", () => {
  // `class` would otherwise produce `{ "class": class }` — invalid JavaScript.
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["class"] } })), `{ "class": value }`);
});

test("a required key that cannot be an identifier is sanitized", () => {
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["user-name"] } })), `{ "user-name": user_name }`);
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["1st"] } })), `{ "1st": _1st }`);
  assert.equal(buildExecutionPlanArgs(tool({ inputSchema: { required: ["!!"] } })), `{ "!!": tool }`);
});

test("browser navigation tools get the interactive default instead of placeholders", () => {
  const nav = tool({
    serverName: "ccr-browser-automation",
    remoteToolName: "browser_navigate",
    inputSchema: { required: ["url"] }
  });
  assert.equal(isBrowserNavigationTool(nav), true);
  assert.equal(buildExecutionPlanArgs(nav), `{ url, waitUntil: "interactive" }`);
});

test("browser automation tools that are not navigation keep schema-derived args", () => {
  const other = tool({ serverName: "ccr-browser-automation", remoteToolName: "browser_click", inputSchema: { required: ["url"] } });
  assert.equal(isBrowserAutomationTool(other), true);
  assert.equal(isBrowserNavigationTool(other), false);
  assert.equal(buildExecutionPlanArgs(other), `{ "url": url }`);
});

// ---------------------------------------------------------------------------
// The two building blocks, directly
// ---------------------------------------------------------------------------

test("getSchemaRequiredProperties reads only string entries", () => {
  assert.deepEqual(getSchemaRequiredProperties({ required: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(getSchemaRequiredProperties({ required: ["a", 2, false, null] }), ["a"]);
  assert.deepEqual(getSchemaRequiredProperties({}), []);
  assert.deepEqual(getSchemaRequiredProperties(undefined), []);
});

test("toIdentifier sanitizes to a usable JavaScript name", () => {
  assert.equal(toIdentifier("plain"), "plain");
  assert.equal(toIdentifier("with-dash"), "with_dash");
  assert.equal(toIdentifier("many___under"), "many_under");
  assert.equal(toIdentifier("_trimmed_"), "trimmed");
  assert.equal(toIdentifier("1st"), "_1st");
  assert.equal(toIdentifier(""), "tool");
  assert.equal(toIdentifier("!!!"), "tool");
});

test("toPlanVariableName lowercases a leading capital, as the plan builder does", () => {
  assert.equal(toPlanVariableName("Widget"), "widget");
  assert.equal(toPlanVariableName("widget"), "widget");
  assert.equal(toPlanVariableName("await"), "value");
});

// ---------------------------------------------------------------------------
// Name resolution: the sketch's author writes several forms of the same tool
// ---------------------------------------------------------------------------

test("a call using the BARE remoteToolName is repaired", () => {
  // The form a live resolve actually emitted, with flattened arguments. The
  // first version of the repair matched only the catalog name, so this case
  // silently skipped it.
  const live = `await callTool("deepseek_chat_completion", { messages: [{ role: "user", content: "x" }], reasoning_effort: "ultra", max_tokens: 64, });`;
  assert.equal(
    repairSketchArguments(live, ENVELOPE_TOOL),
    `await callTool("deepseek_chat_completion", { "params": { messages: [{ role: "user", content: "x" }], reasoning_effort: "ultra", max_tokens: 64, } });`
  );
});

test("a call using the ALIAS form is repaired", () => {
  // ⚠️ `tool()` has no default inputSchema — the envelope has to be passed, or
  // condition 2 fails and the repair correctly declines. Four of these tests
  // were written without it first and failed for that reason, not because the
  // implementation was wrong.
  const aliased = [tool({ inputSchema: ENVELOPE_SCHEMA, alias: "mcp_deepseek_deepseek_chat_completion" })];
  const sketch = `x = callTool("mcp_deepseek_deepseek_chat_completion", { messages: [] });`;
  assert.equal(
    repairSketchArguments(sketch, aliased),
    `x = callTool("mcp_deepseek_deepseek_chat_completion", { "params": { messages: [] } });`
  );
});

test("all three name forms resolve to the same tool", () => {
  const tools = [tool({ inputSchema: ENVELOPE_SCHEMA, alias: "mcp_deepseek_deepseek_chat_completion" })];
  for (const name of ["mcp.deepseek.deepseek_chat_completion", "deepseek_chat_completion", "mcp_deepseek_deepseek_chat_completion"]) {
    const sketch = `x = callTool("${name}", { messages: [] });`;
    assert.equal(repairSketchArguments(sketch, tools), `x = callTool("${name}", { "params": { messages: [] } });`, `for ${name}`);
  }
});

test("a tool without an alias still resolves by its other names", () => {
  const noAlias = [tool({ inputSchema: ENVELOPE_SCHEMA })];
  assert.equal(repairSketchArguments(`x = callTool("deepseek_chat_completion", { a: 1 });`, noAlias),
    `x = callTool("deepseek_chat_completion", { "params": { a: 1 } });`);
});

test("a colliding remoteToolName cannot shadow another tool's catalog name", () => {
  const impostor = tool({ inputSchema: ENVELOPE_SCHEMA, toolName: "mcp.other.thing", remoteToolName: "mcp.deepseek.deepseek_chat_completion" });
  const real = tool({ inputSchema: ENVELOPE_SCHEMA });
  const sketch = `x = callTool("mcp.deepseek.deepseek_chat_completion", { a: 1 });`;
  // Both resolve to a tool carrying the envelope schema; the point is that the
  // repair still fires and still wraps under the same key.
  assert.equal(repairSketchArguments(sketch, [real, impostor]), `x = callTool("mcp.deepseek.deepseek_chat_completion", { "params": { a: 1 } });`);
});

test("an unresolvable name is still left alone", () => {
  const sketch = `x = callTool("mcp.unknown.tool", { a: 1 });`;
  assert.equal(repairSketchArguments(sketch, ENVELOPE_TOOL), sketch);
});
