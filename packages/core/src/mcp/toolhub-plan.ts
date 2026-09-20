/**
 * Dependency-plan + identifier synthesis for the ToolHub resolver
 * (toolhub-mcp.ts).
 *
 * This module owns everything that turns a resolved tool set into the
 * `executionPlanJs` string the client executes: the plan-fallback builders, the
 * per-tool argument placeholder synthesis, the JavaScript-identifier sanitizer
 * used for step/variable names, browser-automation/-navigation tool detection,
 * the `inputSchema.required` reader the placeholders are derived from, and the
 * sketch argument repair (`repairSketchArguments`).
 *
 * Extracted from toolhub-mcp.ts (which is a single 3k-line module) so this
 * logic can be unit-tested in isolation — as a module-private set of functions
 * it had no import surface at all, so no test could reach it. The extraction
 * moved code without changing behaviour; `repairSketchArguments` was added
 * afterwards, and is the one behaviour this module has changed since. The
 * sibling `toolhub-mcp-session.ts` exists for the same reason (session-loss
 * classification).
 *
 * Two paths produce a plan and they deliberately have different guarantees:
 *
 *   - the **sketch** path — a non-empty `workflowSketch` (authored upstream by
 *     the resolve step) is returned trimmed and is preferred whenever it is
 *     present. Its text is left byte-identical except for
 *     `repairSketchArguments`, which re-wraps only those `callTool` invocations
 *     that are provably missing the single object property their tool's
 *     `inputSchema` requires. It may still name arguments the schema does not
 *     declare;
 *   - the **schema-derived fallback** path — `buildSequentialExecutionPlanJs`
 *     synthesizes a sequential plan keyed off `inputSchema.required` only, so it
 *     emits a placeholder variable per required key and nothing else; it is
 *     valid JavaScript but its arguments are placeholders the caller must fill.
 *
 * The sketch is not otherwise checked against `inputSchema`: the repair is
 * targeted at the flattened-envelope defect, not a schema validation pass, and
 * any sketch the repair cannot locate arguments in confidently is returned
 * exactly as authored — it fails open to the previous behaviour.
 *
 * The tool parameter is typed structurally rather than as the resolver's
 * `CatalogEntry`: importing that type back from toolhub-mcp.ts would create an
 * import cycle. Structural typing keeps every existing caller type-checking
 * unchanged.
 */

/** The catalog fields the plan builders actually read. */
export type PlanToolEntry = {
  /**
   * The catalog's generator-facing name (`mcp.deepseek.deepseek_chat_completion`).
   * Optional because it is only read by the sketch repair's name matching, and a
   * caller that omits it should lose that match rather than fail to compile —
   * every real caller passes a `CatalogEntry`, which always carries it.
   */
  alias?: string;
  inputSchema?: Record<string, unknown>;
  remoteToolName: string;
  serverId: string;
  serverName: string;
  serverNamespace: string;
  toolName: string;
};

export const reservedJavaScriptWords = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield"
    .split(" ")
);

/** Sanitize an arbitrary label into a JavaScript identifier. */
export function toIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "tool";
  }
  return /^\d/.test(normalized) ? `_${normalized}` : normalized;
}

/** True when the tool belongs to the browser-automation server. */
export function isBrowserAutomationTool(tool: PlanToolEntry): boolean {
  return tool.serverName === "ccr-browser-automation" ||
    tool.serverId === "ccr-browser-automation" ||
    tool.serverNamespace === "ccr_browser_automation" ||
    tool.toolName.startsWith("mcp.ccr_browser_automation.");
}

/** Sequential plan used when the resolve step produced no sketch. */
export function buildLocalFallbackWorkflowSketch(selectedTools: PlanToolEntry[]): string | undefined {
  return selectedTools.length > 0 ? buildSequentialExecutionPlanJs(selectedTools) : undefined;
}

/** True when the tool opens or navigates a browser session. */
export function isBrowserNavigationTool(tool: PlanToolEntry): boolean {
  return isBrowserAutomationTool(tool) && (
    tool.toolName.endsWith("browser_session_open") ||
    tool.toolName.endsWith("browser_navigate") ||
    tool.remoteToolName === "browser_session_open" ||
    tool.remoteToolName === "browser_navigate"
  );
}

/**
 * The plan for a resolve: the sketch when one is present (repaired), else the
 * schema-derived sequential fallback.
 */
export function buildExecutionPlanJs(workflowSketch: string | undefined, selectedTools: PlanToolEntry[]): string {
  const trimmed = typeof workflowSketch === "string" ? workflowSketch.trim() : "";
  return trimmed ? repairSketchArguments(trimmed, selectedTools) : buildSequentialExecutionPlanJs(selectedTools);
}

/** One `await callTool(...)` step per selected tool, in order. */
export function buildSequentialExecutionPlanJs(selectedTools: PlanToolEntry[]): string {
  if (selectedTools.length === 0) {
    return [
      "async function runWithToolHub() {",
      "  // Ask the user for missing task details before invoking tools.",
      "}"
    ].join("\n");
  }
  const lines = [
    "async function runWithToolHub() {",
    "  // Invoke calls in this order unless the plan explicitly uses Promise.all."
  ];
  selectedTools.forEach((tool, index) => {
    lines.push(`  const step${index + 1} = await callTool(${JSON.stringify(tool.toolName)}, ${buildExecutionPlanArgs(tool)});`);
  });
  lines.push("}");
  return lines.join("\n");
}

/**
 * Argument object literal for one step: an interactive-navigation default for
 * browser navigation tools, else one placeholder variable per required schema
 * property, else `{}`.
 */
export function buildExecutionPlanArgs(tool: PlanToolEntry): string {
  if (isBrowserNavigationTool(tool)) {
    return "{ url, waitUntil: \"interactive\" }";
  }
  const required = getSchemaRequiredProperties(tool.inputSchema);
  if (required.length === 0) {
    return "{}";
  }
  return `{ ${required.map((key) => `${JSON.stringify(key)}: ${toPlanVariableName(key)}`).join(", ")} }`;
}

/** Placeholder variable name for a required argument key. */
export function toPlanVariableName(value: string): string {
  const identifier = toIdentifier(value).replace(/^[A-Z]/, (match) => match.toLowerCase());
  if (!identifier || reservedJavaScriptWords.has(identifier)) {
    return "value";
  }
  return identifier;
}

/** The schema's `required` list, filtered to string entries. */
export function getSchemaRequiredProperties(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Sketch argument repair
// ---------------------------------------------------------------------------

const CALL_TOOL_IDENTIFIER = "callTool";
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;
const WHITESPACE_CHARACTER = /\s/;

const ESCAPED_CHARACTERS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "0": "\0",
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "`": "`"
};

/** A `callTool("name", { … })` whose argument object literal closed cleanly. */
type CallToolInvocation = {
  /** Index of the `}` that closes the argument object literal. */
  argsEnd: number;
  /** Index of the `{` that opens the argument object literal. */
  argsStart: number;
  /** The tool name, as the string literal spelled it. */
  name: string;
  /** Index of the `callTool` identifier itself. */
  start: number;
};

/**
 * Repairs the one defect the sketch path can introduce into the plan: a
 * `callTool` call whose arguments the resolver's LLM flattened to the top level
 * instead of nesting them under the single object property the tool's
 * `inputSchema` requires. The live case is `deepseek_chat_completion`, planned
 * as `{ messages, reasoning_effort }` when the schema requires
 * `{ params: { … } }` — the args type it was handed declared `params` as
 * required and it ignored it. The plan is what the client executes, so the
 * malformed call is what reaches the tool.
 *
 * A call is re-wrapped as `{ "<requiredKey>": <original arguments> }` only when
 * all of these hold:
 *
 *   1. its tool name resolves to one of `selectedTools` — matched against the
 *      catalog name, the remote tool name **and** the alias, because the sketch's
 *      author writes all three forms (`mcp.deepseek.deepseek_chat_completion`,
 *      `deepseek_chat_completion`, `mcp_deepseek_deepseek_chat_completion`) and a
 *      name that fails to resolve simply skips the repair;
 *   2. that tool's `inputSchema.required` is exactly one entry;
 *   3. that entry's schema in `inputSchema.properties` is `type: "object"`;
 *   4. its argument is a non-empty object literal;
 *   5. its argument does not already carry that required key.
 *
 * Everything else is returned byte-identical, and anything the scan cannot read
 * confidently — an object literal that does not close, an argument that is not
 * an object literal, a call nested inside another call's arguments — is left
 * exactly as authored. The repair therefore fails open to the previous
 * behaviour rather than mangling a sketch it could not parse.
 *
 * ⚠️ Matching only the catalog `toolName` was the first version, and a live resolve
 * emitted the BARE name (`callTool("deepseek_chat_completion", …)`) with flattened
 * arguments — a real case that silently skipped the repair. All three forms are
 * indexed now.
 */
export function repairSketchArguments(sketch: string, selectedTools: PlanToolEntry[]): string {
  const toolByName = new Map<string, PlanToolEntry>();
  for (const tool of selectedTools) {
    // First writer wins, so a tool whose remoteToolName or alias collides with
    // another tool's catalog name cannot shadow that tool.
    for (const name of [tool.toolName, tool.remoteToolName, tool.alias]) {
      if (name && !toolByName.has(name)) {
        toolByName.set(name, tool);
      }
    }
  }
  if (toolByName.size === 0) {
    return sketch;
  }
  const inCode = markCodePositions(sketch);
  const repairs: Array<{ end: number; start: number; text: string }> = [];
  let previousArgsEnd = -1;
  for (const invocation of findCallToolInvocations(sketch, inCode)) {
    // Nested inside an earlier call's arguments: repairing it would mean
    // rewriting text that is itself already being rewritten.
    if (invocation.start < previousArgsEnd) {
      continue;
    }
    previousArgsEnd = invocation.argsEnd;
    const tool = toolByName.get(invocation.name);
    const requiredKey = tool ? singleRequiredObjectKey(tool) : undefined;
    if (requiredKey === undefined) {
      continue;
    }
    // `{ }` and `{ /* … */ }` are empty argument objects: nothing to wrap.
    if (skipTrivia(sketch, inCode, invocation.argsStart + 1, invocation.argsEnd) >= invocation.argsEnd) {
      continue;
    }
    const args = sketch.slice(invocation.argsStart, invocation.argsEnd + 1);
    if (collectTopLevelObjectKeys(sketch, inCode, invocation.argsStart, invocation.argsEnd).has(requiredKey)) {
      continue;
    }
    repairs.push({ end: invocation.argsEnd + 1, start: invocation.argsStart, text: `{ ${JSON.stringify(requiredKey)}: ${args} }` });
  }
  if (repairs.length === 0) {
    return sketch;
  }
  let repaired = "";
  let cursor = 0;
  for (const repair of repairs) {
    repaired += sketch.slice(cursor, repair.start) + repair.text;
    cursor = repair.end;
  }
  return repaired + sketch.slice(cursor);
}

/**
 * The tool's sole required property, when the schema declares it as an object —
 * the shape this repair can wrap an argument under.
 */
function singleRequiredObjectKey(tool: PlanToolEntry): string | undefined {
  const required = tool.inputSchema?.required;
  if (!Array.isArray(required) || required.length !== 1) {
    return undefined;
  }
  const [key] = getSchemaRequiredProperties(tool.inputSchema);
  if (key === undefined) {
    return undefined;
  }
  const properties = tool.inputSchema?.properties;
  const propertySchema = typeof properties === "object" && properties !== null
    ? (properties as Record<string, unknown>)[key]
    : undefined;
  return typeof propertySchema === "object" && propertySchema !== null &&
      (propertySchema as Record<string, unknown>).type === "object"
    ? key
    : undefined;
}

/** Every `callTool("name", { … })` in `source` whose argument object closed. */
function findCallToolInvocations(source: string, inCode: boolean[]): CallToolInvocation[] {
  const invocations: CallToolInvocation[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(CALL_TOOL_IDENTIFIER, searchFrom);
    if (start < 0) {
      return invocations;
    }
    searchFrom = start + CALL_TOOL_IDENTIFIER.length;
    // A `callTool(…)` inside a string or a comment is text, not a call.
    if (!inCode[start] || (start > 0 && IDENTIFIER_CHARACTER.test(source[start - 1]))) {
      continue;
    }
    const openParen = skipTrivia(source, inCode, searchFrom, source.length);
    if (source[openParen] !== "(") {
      continue;
    }
    const name = readStringLiteral(source, skipTrivia(source, inCode, openParen + 1, source.length));
    if (name === undefined) {
      continue;
    }
    const comma = skipTrivia(source, inCode, name.end, source.length);
    if (source[comma] !== ",") {
      continue;
    }
    const argsStart = skipTrivia(source, inCode, comma + 1, source.length);
    if (source[argsStart] !== "{") {
      continue;
    }
    const argsEnd = matchBalancedBraces(source, inCode, argsStart);
    if (argsEnd === undefined) {
      continue;
    }
    // The call must close immediately after the object literal. When it does
    // not, those braces are not this call's argument — decline to guess.
    if (source[skipTrivia(source, inCode, argsEnd + 1, source.length)] !== ")") {
      continue;
    }
    invocations.push({ argsEnd, argsStart, name: name.value, start });
  }
}

/**
 * The index of the `}` closing the object literal opened at `open`, or
 * `undefined` when it never closes. Braces inside strings, template literals and
 * comments do not count — the real sketches nest objects and quote braces.
 */
function matchBalancedBraces(source: string, inCode: boolean[], open: number): number | undefined {
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (!inCode[cursor]) {
      continue;
    }
    const character = source[cursor];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return undefined;
}

/**
 * The property names written directly on the object literal spanning
 * `open`…`close`. Used only to answer "does this argument already carry that
 * key?", so a property the reader does not understand is simply not reported.
 */
function collectTopLevelObjectKeys(source: string, inCode: boolean[], open: number, close: number): Set<string> {
  const segments: Array<[number, number]> = [];
  let depth = 0;
  let segmentStart = open + 1;
  for (let cursor = open + 1; cursor < close; cursor += 1) {
    if (!inCode[cursor]) {
      continue;
    }
    const character = source[cursor];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      segments.push([segmentStart, cursor]);
      segmentStart = cursor + 1;
    }
  }
  segments.push([segmentStart, close]);
  const keys = new Set<string>();
  for (const [start, end] of segments) {
    const key = readPropertyKey(source, inCode, start, end);
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
}

/** The property name a `key: value` — or shorthand `key` — segment opens with. */
function readPropertyKey(source: string, inCode: boolean[], start: number, end: number): string | undefined {
  const cursor = skipTrivia(source, inCode, start, end);
  const literal = readStringLiteral(source, cursor);
  if (literal !== undefined) {
    return source[skipTrivia(source, inCode, literal.end, end)] === ":" ? literal.value : undefined;
  }
  let name = "";
  let index = cursor;
  while (index < end && IDENTIFIER_CHARACTER.test(source[index])) {
    name += source[index];
    index += 1;
  }
  if (!name) {
    return undefined;
  }
  const afterName = skipTrivia(source, inCode, index, end);
  if (afterName >= end) {
    return name;
  }
  const following = source[afterName];
  return following === ":" || following === "," ? name : undefined;
}

/** Reads the `'…'` or `"…"` literal at `start`; `undefined` when there is none. */
function readStringLiteral(source: string, start: number): { end: number; value: string } | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const escape = readEscapeSequence(source, index);
      if (escape === undefined) {
        return undefined;
      }
      value += escape.value;
      index = escape.end;
      continue;
    }
    if (character === quote) {
      return { end: index + 1, value };
    }
    // An unescaped newline ends the literal: a malformed sketch must not swallow
    // the rest of the source as one unterminated string.
    if (character === "\n") {
      return undefined;
    }
    value += character;
    index += 1;
  }
  return undefined;
}

/** Reads the escape sequence at `start` (a backslash). */
function readEscapeSequence(source: string, start: number): { end: number; value: string } | undefined {
  const marker = source[start + 1];
  if (marker === undefined) {
    return undefined;
  }
  const escaped = ESCAPED_CHARACTERS[marker];
  if (escaped !== undefined) {
    return { end: start + 2, value: escaped };
  }
  const hex = marker === "x" ? source.slice(start + 2, start + 4) : marker === "u" ? source.slice(start + 2, start + 6) : undefined;
  if (hex !== undefined) {
    return /^[0-9a-fA-F]+$/.test(hex) && (marker === "x" ? hex.length === 2 : hex.length === 4)
      ? { end: start + 2 + hex.length, value: String.fromCharCode(parseInt(hex, 16)) }
      : undefined;
  }
  // A line continuation, or an escape with no special meaning: the character
  // stands for itself.
  return { end: start + 2, value: marker };
}

/**
 * Marks every character of `source` that is real code — outside string and
 * template literals and outside comments. Template `${ … }` bodies are code
 * again, tracked with a frame so a nested template or object literal inside one
 * does not derail the scan.
 */
function markCodePositions(source: string): boolean[] {
  const inCode = new Array<boolean>(source.length).fill(false);
  const frames: Array<{ depth: number; kind: "block-comment" | "template-expression" }> = [];
  let mode: "block-comment" | "code" | "double" | "line-comment" | "single" | "template" = "code";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (mode === "code") {
      const frame = frames[frames.length - 1];
      if (frame?.kind === "template-expression" && character === "}" && frame.depth === 0) {
        // The `}` that closes a `${ … }` belongs to the template, not to the
        // code around it: brace matching must not see it.
        frames.pop();
        mode = "template";
        index += 1;
        continue;
      }
      inCode[index] = true;
      if (character === "/" && source[index + 1] === "/") {
        mode = "line-comment";
        index += 2;
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        frames.push({ depth: 0, kind: "block-comment" });
        mode = "block-comment";
        index += 2;
        continue;
      }
      if (character === '"') {
        mode = "double";
        index += 1;
        continue;
      }
      if (character === "'") {
        mode = "single";
        index += 1;
        continue;
      }
      if (character === "`") {
        mode = "template";
        index += 1;
        continue;
      }
      if (frame?.kind === "template-expression") {
        if (character === "{") {
          frame.depth += 1;
        } else if (character === "}") {
          frame.depth -= 1;
        }
      }
      index += 1;
      continue;
    }
    if (mode === "line-comment") {
      if (character === "\n") {
        mode = "code";
      }
      index += 1;
      continue;
    }
    if (mode === "block-comment") {
      if (character === "*" && source[index + 1] === "/") {
        frames.pop();
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "\n" || character === (mode === "single" ? "'" : '"')) {
        mode = "code";
      }
      index += 1;
      continue;
    }
    // Inside a template literal's raw text.
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      mode = "code";
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "{") {
      frames.push({ depth: 0, kind: "template-expression" });
      mode = "code";
      index += 2;
      continue;
    }
    index += 1;
  }
  return inCode;
}

/**
 * Advances over whitespace and comments. Strings are not trivia: the quote that
 * opens one is a code character, so the scan stops on it.
 */
function skipTrivia(source: string, inCode: boolean[], from: number, end: number): number {
  let cursor = from;
  while (cursor < end) {
    if (WHITESPACE_CHARACTER.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (!inCode[cursor]) {
      cursor += 1;
      continue;
    }
    // The `/` opening a comment is marked as code; the comment body is not.
    if (source[cursor] === "/" && cursor + 1 < end && !inCode[cursor + 1]) {
      cursor += 1;
      while (cursor < end && !inCode[cursor]) {
        cursor += 1;
      }
      continue;
    }
    break;
  }
  return cursor;
}
