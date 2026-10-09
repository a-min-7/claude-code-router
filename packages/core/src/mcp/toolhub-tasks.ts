// ──────────────────────────────────────────────────────────────────────────────
// The resolver's MCP **Tasks** (SEP-2663) runtime.
//
// ⚠️ **Why this file exists at all.** `protocol-era.ts` declares the Tasks
// extension to every backend server — a promise that the server MAY answer
// `tools/call` with a `CreateTaskResult` (`resultType: "task"`) instead of a
// result. The SDK cannot consume one: its 2026-era codec decodes a result before
// the caller's schema is consulted and marshals anything other than
// `resultType: "complete"` (and `input_required`) into
// `SdkError(UnsupportedResultType)`. Measured 2026-10-09 against
// `@modelcontextprotocol/client` 2.3.1 with a stub: `callTool()` rejects, and the
// explicit-schema `request()` path rejects identically, so **no path through the
// SDK's public surface yields the `taskId`** — the answer is lost and
// `perplexity_research` fails outright.
//
// The way through is the one `@modelcontextprotocol/ext-tasks` is built for: the
// host owns a **raw JSON-RPC channel** on the transport (its own docs name the
// seam — *"Host-owned request coordinator used when SDK wire codecs reject V2
// task traffic"*), and drives the task protocol itself. Only `tasks/get` and
// `tasks/cancel` are reachable through `client.request()` — the SDK exempts
// exactly those two from the era gate via `isExtensionReusedRequestMethod`.
//
// This is a port of the load-bearing parts of `pi-mcp-adapter` v5.1.0
// `dist/mcp-tasks.js`, plus two things that package leaves to its host:
// a wall-clock **deadline** narrowed by the task's own `ttlMs`, and a bounded
// **transient-error retry** that re-attaches with `resumeTask` instead of
// discarding a durable task over one failed poll.
//
// ⚠️ **Servers that never return tasks must keep today's code path.** Nothing
// here attaches unless `serverAdvertisesTasks()` says yes: no channel is
// installed on the transport, no session is created, and the adapter's existing
// `callTool` branch runs unchanged.
// ──────────────────────────────────────────────────────────────────────────────

import { INTERNAL_ERROR, ProtocolError } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import {
  createApplicationInputHandler,
  createTaskSessionEndpointId,
  createTaskSessionFromClient,
  DispatchError,
  JsonRpcResponseError,
  resultFromTaskOutcome,
  TaskCancelledError,
  TaskFailedError,
  type DispatchOptions,
  type JsonRpcResponse,
  type ResolvedInputExchangeContext,
  type TaskEnabledSession,
  type TaskView,
  type ToolExecution
} from "@modelcontextprotocol/ext-tasks/client";
import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import { TASKS_EXTENSION_ID } from "@ccr/core/mcp/protocol-era";

/**
 * ⚠️ Derived from the factory's own signature, never re-imported. A second
 * `import type { Client }` of the same package resolves through the other
 * `exports` condition (CJS vs ESM) and produces a nominal type with a separate
 * private `_clientInfo`, so the two spellings of the same class are not
 * assignable to each other.
 */
type SdkClient = Parameters<typeof createTaskSessionFromClient>[0];

/** The lifted tool result the adapters return, minus the wire-only discriminator. */
type LiftedToolResult = Record<string, unknown>;

type RawJsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type RawRequestEntry = {
  id: string;
  resolve: (outcome: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  state: "pending" | "observing";
  isToolCall: boolean;
  /** Aborts the underlying transport request once nobody is waiting for it. */
  observationController?: AbortController;
  requestTimer?: ReturnType<typeof setTimeout>;
  observationTimer?: ReturnType<typeof setTimeout>;
};

/** Raw requests use a prefixed string id so they can never collide with the SDK's numeric ids. */
const RAW_REQUEST_ID_PREFIX = "ccr-tasks-";

/**
 * How long a locally-timed-out `tools/call` keeps watching for a late task
 * handle, so a task the server created *after* our request timeout is cancelled
 * rather than left running (and billing) with nobody polling it.
 */
const LATE_TASK_HANDLE_GRACE_MS = 60_000;

/**
 * The ceiling on a task-backed tool call, whatever the server reports.
 *
 * ⚠️ This must stay well inside Claude Code's MCP **idle** timeout for the
 * transport `ccr-toolhub` actually uses: stdio is 30 minutes, HTTP/SSE 5. The
 * resolver never sets `MCP_TOOL_TIMEOUT`, so the ~28 h wall-clock default is not
 * the constraint; idleness is.
 */
const HARD_MAX_TASK_DEADLINE_MS = 900_000;

/** Stop just short of the task's TTL: the final poll is itself a request. */
const TASK_DEADLINE_HEADROOM_MS = 1_000;

/** Extra attempts after the first, for a *transient* poll failure only. */
const TASK_POLL_RETRY_ATTEMPTS = 2;

/** How long the abort path waits for `tasks/cancel` before returning anyway. */
const CANCEL_DISPATCH_BUDGET_MS = 5_000;

export type ToolHubTaskRuntime = {
  /** Call a tool, driving a task to completion when the server returns one. */
  execute(name: string, args: Record<string, unknown>, requestTimeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
};

/**
 * Whether the connected server can legally answer with a task handle.
 *
 * Both halves are required, and the extension check mirrors ext-tasks' own: it
 * requires the **exact empty-object** declaration and downgrades the session
 * otherwise. A legacy-era connection is out of scope by design — the 2025-11-25
 * task vocabulary needs per-tool `taskSupport` opt-in, which we do not supply.
 */
export function serverAdvertisesTasks(client: SdkClient): boolean {
  if (client.getProtocolEra?.() !== "modern") {
    return false;
  }
  const extension = client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID];
  return (
    typeof extension === "object" &&
    extension !== null &&
    !Array.isArray(extension) &&
    Object.keys(extension).length === 0
  );
}

/**
 * A raw JSON-RPC request channel chained in front of the SDK's own transport
 * handlers.
 *
 * ⚠️ **Attach only after `Client.connect()`** — `attach()` reads whatever
 * `onmessage`/`onclose` are installed at that moment and delegates to them, so
 * attaching first would swallow the SDK's own dispatch. Responses whose string
 * id carries our prefix are consumed here and never reach the SDK; everything
 * else passes through untouched.
 */
export class RawRequestChannel {
  private readonly pending = new Map<string, RawRequestEntry>();
  private requestCounter = 0;
  private attached = false;

  constructor(
    private readonly transport: Transport,
    private readonly defaultTimeoutMs: number
  ) {}

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    const previousOnMessage = this.transport.onmessage;
    this.transport.onmessage = (message, extra) => {
      if (this.consumeRawResponse(message as RawJsonRpcMessage)) {
        return;
      }
      previousOnMessage?.(message, extra);
    };
    const previousOnClose = this.transport.onclose;
    this.transport.onclose = () => {
      this.rejectAll(new Error("MCP connection closed"));
      previousOnClose?.();
    };
  }

  detach(): void {
    this.attached = false;
    this.rejectAll(new Error("MCP tasks channel detached"));
  }

  /** Sends a raw JSON-RPC request and resolves with its correlated response. */
  readonly rawDispatch = (request: JsonValue, options?: DispatchOptions): Promise<JsonRpcResponse> => {
    // ext-tasks hands us a generic JSON value; the contract is a JSON-RPC request.
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      return Promise.reject(new Error("Raw MCP request must be a JSON object"));
    }
    const { method, params } = request as { method?: unknown; params?: unknown };
    if (typeof method !== "string") {
      return Promise.reject(new Error("Raw MCP request must carry a string method"));
    }
    const id = `${RAW_REQUEST_ID_PREFIX}${++this.requestCounter}`;
    const message: RawJsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    };
    const timeoutMs = options?.context?.requestTimeoutMs ?? this.defaultTimeoutMs;

    const isToolCall = method === "tools/call";

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const entry: RawRequestEntry = {
        id,
        resolve,
        reject,
        state: "pending",
        isToolCall,
        // A task-producing tools/call owns its transport observation separately
        // from the caller's wait, so a local timeout cannot silently orphan a
        // task the server is still creating.
        ...(isToolCall ? { observationController: new AbortController() } : {})
      };
      entry.requestTimer = setTimeout(() => {
        this.terminateLocalWait(entry, new Error(`MCP task request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, entry);

      const fail = (error: unknown) => {
        if (this.pending.get(id) !== entry) {
          return;
        }
        const wasPending = entry.state === "pending";
        this.finishEntry(entry, true);
        if (wasPending) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      try {
        Promise.resolve(
          this.transport.send(message as Parameters<Transport["send"]>[0], {
            ...(options?.context?.headers === undefined ? {} : { headers: options.context.headers }),
            ...(entry.observationController === undefined
              ? {}
              : { requestSignal: entry.observationController.signal })
          })
        ).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  };

  private consumeRawResponse(message: RawJsonRpcMessage): boolean {
    if (typeof message.id !== "string" || !message.id.startsWith(RAW_REQUEST_ID_PREFIX)) {
      return false;
    }
    // A server may pick any string id, including our prefix. A frame carrying a
    // method is a server→client request and belongs to the SDK's handler.
    if ("method" in message) {
      return false;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return true; // ours, but already settled
    }
    const wasObserving = entry.state === "observing";
    this.finishEntry(entry, true);
    if (wasObserving) {
      // The local wait already gave up; a task created after it would otherwise
      // run server-side with nobody polling it.
      void this.cancelLateTask(message).catch(() => undefined);
      return true;
    }
    if (message.error) {
      entry.resolve({
        kind: "error",
        error: {
          code: message.error.code,
          message: message.error.message,
          ...(message.error.data === undefined ? {} : { data: message.error.data as JsonValue })
        }
      });
    } else if ("result" in message) {
      entry.resolve({ kind: "result", result: message.result as JsonValue });
    } else {
      entry.reject(new Error("MCP task response frame carried neither result nor error"));
    }
    return true;
  }

  /** A `tools/call` that timed out locally keeps watching briefly for a late task handle. */
  private terminateLocalWait(entry: RawRequestEntry, error: Error): void {
    if (this.pending.get(entry.id) !== entry || entry.state !== "pending") {
      return;
    }
    if (entry.observationController === undefined) {
      this.finishEntry(entry, false);
    } else {
      entry.state = "observing";
      this.clearRequestTimer(entry);
      entry.observationTimer = setTimeout(() => {
        this.finishEntry(entry, true);
      }, LATE_TASK_HANDLE_GRACE_MS);
    }
    entry.reject(error);
  }

  private async cancelLateTask(message: RawJsonRpcMessage): Promise<void> {
    const result = message.result;
    if (typeof result !== "object" || result === null) {
      return;
    }
    const task = result as { resultType?: unknown; taskId?: unknown };
    if (task.resultType !== "task" || typeof task.taskId !== "string") {
      return;
    }
    const taskId = task.taskId;
    await this.rawDispatch(
      { method: "tasks/cancel", params: { taskId } },
      { context: { headers: { "Mcp-Name": taskId } } }
    );
  }

  private clearRequestTimer(entry: RawRequestEntry): void {
    if (entry.requestTimer !== undefined) {
      clearTimeout(entry.requestTimer);
      entry.requestTimer = undefined;
    }
  }

  private finishEntry(entry: RawRequestEntry, abortObservation: boolean): void {
    if (this.pending.get(entry.id) !== entry) {
      return;
    }
    this.clearRequestTimer(entry);
    if (entry.observationTimer !== undefined) {
      clearTimeout(entry.observationTimer);
      entry.observationTimer = undefined;
    }
    this.pending.delete(entry.id);
    if (abortObservation) {
      entry.observationController?.abort();
    }
  }

  private rejectAll(reason: Error): void {
    for (const entry of [...this.pending.values()]) {
      const wasPending = entry.state === "pending";
      this.finishEntry(entry, true);
      if (wasPending) {
        entry.reject(reason);
      }
    }
  }
}

/**
 * Attach a task runtime to a connected client.
 *
 * Returns `undefined` — attaching nothing and changing nothing — whenever the
 * server does not advertise the extension, or whenever ext-tasks hands back a
 * session without execution support. That second case matters: a downgraded
 * session would route *plain* tool calls through the generic request path and
 * skip `callTool`'s output-schema validation, so a silent downgrade is worse
 * than no tasks at all.
 */
export async function attachToolHubTaskRuntime(options: {
  /**
   * ⚠️ Deliberately `unknown`, and cast once below.
   *
   * The SDK ships **dual CJS/ESM declarations**. This package compiles as CJS, so
   * its own `Client` resolves to `index.d.cts`; ext-tasks' `.d.ts` — an ESM
   * module — resolves the same specifier through the `import` condition to
   * `index.d.mts`. TypeScript treats the two as unrelated because each declares a
   * private `_clientInfo`, even though the runtime value is one and the same
   * class. Casting once here keeps the knowledge (and the exception) in the file
   * that owns the SDK integration, instead of in every caller.
   */
  client: unknown;
  transport: Transport;
  server: { name: string; url?: string; command?: string; args?: string[] };
  serverConfigTimeoutMs: number;
  clientInfo: { name: string; version: string };
  clientCapabilities: Readonly<Record<string, JsonValue>>;
  onError?: (error: unknown) => void;
}): Promise<ToolHubTaskRuntime | undefined> {
  const { transport, server } = options;
  const client = options.client as SdkClient;
  if (!serverAdvertisesTasks(client)) {
    return undefined;
  }
  const protocolVersion = client.getNegotiatedProtocolVersion?.();
  if (protocolVersion === undefined) {
    return undefined;
  }

  const endpointId = await createTaskSessionEndpointId("ccr-toolhub", {
    server: server.name,
    ...(server.command !== undefined
      ? { transport: { type: "stdio", command: server.command, args: server.args ?? [] } }
      : { transport: { type: "http", url: server.url ?? "" } })
  });

  // ⚠️ Attach only once the session exists. Attaching first would leave a wrapper
  // installed on this transport's `onmessage`/`onclose` for the client's whole
  // lifetime if the factory below throws — inert, but unclaimed state that nothing
  // ever removes.
  const channel = new RawRequestChannel(transport, options.serverConfigTimeoutMs);

  const session: TaskEnabledSession = createTaskSessionFromClient(client, {
    endpointId,
    rawDispatch: channel.rawDispatch,
    v2RequestFraming: {
      protocolVersion,
      clientInfo: options.clientInfo,
      clientCapabilities: options.clientCapabilities
    },
    // Per-tool `taskSupport` hints only; a miss is harmless.
    tools: { currentTool: () => undefined },
    onInputRequest: createApplicationInputHandler({
      // ⚠️ The resolver has no user-facing surface, so a task that asks for
      // input is refused loudly rather than answered with a fabricated result.
      elicitation: () => {
        throw unsupportedTaskInputError("elicitation/create");
      },
      sampling: () => {
        throw unsupportedTaskInputError("sampling/createMessage");
      },
      roots: () => ({ roots: [] })
    }),
    onError: (error: unknown) => options.onError?.(error)
  });

  if (!session.capabilities.execution) {
    await session.close().catch(() => undefined);
    channel.detach();
    return undefined;
  }

  channel.attach();

  return {
    async execute(name, args, requestTimeoutMs) {
      return runTaskBackedCallTool({ session, name, args, requestTimeoutMs });
    },
    async close() {
      await session.close().catch(() => undefined);
      channel.detach();
    }
  };
}

function unsupportedTaskInputError(method: string): Error {
  const error = new Error(`MCP server requested ${method} during a task, but the resolver has no handler for it`);
  Object.assign(error, { code: "CAPABILITY_NOT_SUPPORTED", data: { method } });
  return error;
}

/**
 * Call a tool through the task session and settle it, preserving the plain
 * `callTool` contract: an immediate result returns as-is, a task-backed
 * execution is polled to completion, a failed task throws the underlying
 * JSON-RPC error.
 */
async function runTaskBackedCallTool(options: {
  session: TaskEnabledSession;
  name: string;
  args: Record<string, unknown>;
  requestTimeoutMs: number;
}): Promise<unknown> {
  const { session, name, args, requestTimeoutMs } = options;

  let execution: ToolExecution<LiftedToolResult>;
  try {
    execution = (await session.callTool(name, args as never, { requestTimeoutMs })) as ToolExecution<LiftedToolResult>;
  } catch (error) {
    throw toCallToolError(error, undefined);
  }

  const deadline = createDeadline();
  deadline.tighten(HARD_MAX_TASK_DEADLINE_MS);
  const watchController = new AbortController();
  let current: ToolExecution<LiftedToolResult> = execution;
  /**
   * ⚠️ Set only on the one path that returns a result to the caller. Every other
   * exit — a non-transient poll error, exhausted retries, a failed re-attach, the
   * deadline — leaves the remote task RUNNING, and an upstream task nobody polls
   * and nobody cancels keeps executing and billing. `close()` does not cancel it:
   * ext-tasks documents that as releasing local ownership.
   */
  let settledForCaller = false;

  try {
    // Narrow the deadline from the task's own TTL as soon as the first
    // observation carries one. `settle` observes independently and does not
    // acquire the updates stream, so this is a second, non-conflicting reader.
    void watchTaskTtl(current, deadline, watchController.signal);

    let lastError: unknown;
    for (let attempt = 0; attempt <= TASK_POLL_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const settlement = await current.settle({ signal: deadline.signal });
        const raw = resultFromTaskOutcome(settlement.outcome) as LiftedToolResult;
        // Match `Client.callTool`'s lifted shape: the wire-only discriminator is stripped.
        const { resultType: _wireOnly, ...lifted } = raw;
        settledForCaller = true;
        return lifted;
      } catch (error) {
        lastError = error;
        if (attempt === TASK_POLL_RETRY_ATTEMPTS || deadline.signal.aborted || !isTransientTaskError(error)) {
          break;
        }
        const resumed = await retryPoll(session, current, deadline.signal);
        if (resumed === undefined) {
          break; // could not re-attach; surface the original failure
        }
        current = resumed;
      }
    }
    throw toCallToolError(lastError, deadline.signal);
  } finally {
    watchController.abort();
    // Cooperatively cancel anything we are walking away from, so a task is never
    // orphaned. This covers the deadline AND every error exit. On an exit where
    // the task had already reached a terminal state the call is a no-op — the
    // spec requires the server to acknowledge cancellation whether or not it can
    // honour it — so over-cancelling is cheaper than losing the job. Awaited, but
    // with a short budget, so a dead transport cannot turn a failure into a
    // two-minute wait before the caller sees it.
    if (!settledForCaller) {
      await Promise.race([
        current.cancel().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CANCEL_DISPATCH_BUDGET_MS))
      ]);
    }
    deadline.dispose();
    await current.close().catch(() => undefined);
  }
}

/** Narrow the deadline to the task's TTL when the server reports one. */
async function watchTaskTtl(
  execution: ToolExecution<LiftedToolResult>,
  deadline: Deadline,
  signal: AbortSignal
): Promise<void> {
  try {
    for await (const event of execution.updates(signal)) {
      if (event.type === "task") {
        deadline.tighten(taskDeadlineMs(event.task.retentionMs, event.task.createdAt));
      }
    }
  } catch {
    // The stream ends when the execution settles or the signal aborts.
  }
}

/** Re-acquire a durable task after a transient poll failure, or give up. */
async function retryPoll(
  session: TaskEnabledSession,
  execution: ToolExecution<LiftedToolResult>,
  signal: AbortSignal
): Promise<ToolExecution<LiftedToolResult> | undefined> {
  if (execution.kind !== "task") {
    return undefined;
  }
  let reference;
  try {
    reference = execution.serializeReference();
  } catch {
    return undefined;
  }
  try {
    return (await session.resumeTask<LiftedToolResult>(reference, { signal })) as ToolExecution<LiftedToolResult>;
  } catch {
    return undefined;
  }
}

/**
 * A transient failure is one that says nothing about the *task*: a local
 * dispatch failure ext-tasks marked retryable, a request timeout, or a closed
 * connection. A JSON-RPC error from the server, a terminal task failure or a
 * cancellation are final — retrying them would only re-fail, or worse, re-drive
 * work the server already reported as done.
 */
function isTransientTaskError(error: unknown): boolean {
  if (error instanceof DispatchError) {
    return error.retryable;
  }
  if (
    error instanceof JsonRpcResponseError ||
    error instanceof TaskFailedError ||
    error instanceof TaskCancelledError ||
    error instanceof ProtocolError
  ) {
    return false;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "REQUEST_TIMEOUT" || code === "CONNECTION_CLOSED" || code === "SEND_FAILED";
}

/**
 * Preserve the error shape `Client.callTool` produces: JSON-RPC failures become
 * the typed `ProtocolError` subclass for their code, so the adapters' existing
 * session-recovery classification keeps working.
 */
export function toCallToolError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof TaskCancelledError && signal?.aborted === true) {
    return abortReason(signal);
  }
  if (error instanceof JsonRpcResponseError) {
    return ProtocolError.fromError(error.code, error.message, error.data as never);
  }
  if (error instanceof TaskFailedError) {
    // ⚠️ Not every task failure carries a protocol code — a code-less one used to
    // fall through to the raw `TaskFailedError`, which the adapters' session-loss
    // classification cannot read and which `Client.callTool` would never have
    // produced. Give it the JSON-RPC internal-error code so every failure leaving
    // here is a typed ProtocolError.
    return ProtocolError.fromError(error.code ?? INTERNAL_ERROR, error.message, error.data as never);
  }
  if (error instanceof DispatchError) {
    // The cause may itself be a JSON-RPC error, so re-map it rather than leaking it.
    return error.cause instanceof JsonRpcResponseError
      ? ProtocolError.fromError(error.cause.code, error.cause.message, error.cause.data as never)
      : error.cause ?? error;
  }
  return error;
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" && reason ? reason : "MCP task aborted");
}

type Deadline = {
  signal: AbortSignal;
  /** Only ever shortens: a later, larger suggestion cannot extend a live deadline. */
  tighten: (ms: number) => void;
  dispose: () => void;
};

function createDeadline(): Deadline {
  const controller = new AbortController();
  let armedMs = Number.POSITIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    signal: controller.signal,
    tighten(ms: number) {
      if (controller.signal.aborted || ms >= armedMs) {
        return;
      }
      armedMs = ms;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        controller.abort(new Error(`MCP task exceeded its ${ms}ms deadline`));
      }, ms);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  } as Deadline;
}

/**
 * The deadline policy, exported so the arithmetic is pinned by a test rather
 * than asserted in a comment: an absent or non-positive `ttlMs` means unlimited
 * retention, which is bounded by the hard ceiling; otherwise stop one request's
 * worth short of the TTL.
 *
 * ⚠️ `ttlMs` is measured **from the task's creation**, not from when we happen to
 * observe it (SEP-2663, and rmcp's `Task` says so outright). So the elapsed time
 * since `createdAt` comes off the budget — otherwise a late first observation
 * arms a deadline *past* the moment the server discards the task, and the task
 * we are still polling no longer exists.
 */
export function taskDeadlineMs(
  ttlMs: number | null | undefined,
  createdAt?: string,
  now: number = Date.now()
): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return HARD_MAX_TASK_DEADLINE_MS;
  }
  const elapsedMs = elapsedSince(createdAt, now);
  const remainingMs = ttlMs - elapsedMs - TASK_DEADLINE_HEADROOM_MS;
  return Math.max(1, Math.min(remainingMs, HARD_MAX_TASK_DEADLINE_MS));
}

/** Milliseconds since an ISO timestamp, or 0 when it is absent or unparseable. */
function elapsedSince(createdAt: string | undefined, now: number): number {
  if (typeof createdAt !== "string" || !createdAt) {
    return 0;
  }
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return 0;
  }
  return Math.max(0, now - createdMs);
}

/** The task's raw `Task` view, exposed for tests that need a snapshot shape. */
export type { TaskView };

export const TASK_DEADLINE_LIMITS = {
  hardMaxMs: HARD_MAX_TASK_DEADLINE_MS,
  headroomMs: TASK_DEADLINE_HEADROOM_MS,
  retryAttempts: TASK_POLL_RETRY_ATTEMPTS,
  lateHandleGraceMs: LATE_TASK_HANDLE_GRACE_MS
} as const;

export type { ResolvedInputExchangeContext };
