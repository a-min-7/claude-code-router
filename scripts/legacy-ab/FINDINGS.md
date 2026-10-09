# Legacy call-leg A/B — findings

Does the `tools/list` + `tools/call` leg against a **legacy-era** MCP backend
(`protocolVersion: "2024-11-05"`, e.g. the two legacy backends used below) behave
identically under the pre-change resolver bundle and the currently-live one?

**Verdict: yes — byte-identical.** Every comparison below produced an empty diff.

## Bundle provenance

`npm run build:assets` is byte-reproducible, so each candidate bundle can be pinned exactly.
Build in a throwaway worktree — **not** the main checkout, and never `sync-ccr.sh`, which
deploys to the live path on both hosts:

```
git worktree add --detach /tmp/old-ccr <sha>
cd /tmp/old-ccr && node build/build.mjs          # build:assets only — NOT `npm run build`
shasum -a 256 packages/core/dist/main/toolhub-mcp.js
```

Materialise `node_modules` in the worktree (per-entry symlinks) so `node_modules/@claude-code-router/*`
resolves *into the worktree*; a symlink to the main `node_modules` would build the main checkout instead.

| tag | bytes | sha256 | provenance |
|---|---|---|---|
| NEW (live) | 1,071,506 | `93441aa6…d9138e` | build @ `4fcd7d70`; main `dist` ≡ deployed `~/.claude-code-router/bin/toolhub-mcp.js` |
| **pre-change** | **655,310** | `90b4b476…d6ff56` | build @ `0b16e930` — the bundle live before the 2026-10-09 14:15 change |
| — | 655,226 | `5e7f0eaf…9ad7ff` | build @ `9133c2ca` |
| — | 655,270 | `1c39779b…a205d4` | build @ `5d1b4663`; **byte-identical to `toolhub-mcp.js.bak-20261009-tasks`** |

Note for whoever revisits this: the two OLD candidates in the original task brief ("restore the
`.bak`" and "rebuild at `5d1b4663`") are the **same artifact**, and **neither** is the 655,310 that
was actually live. `0b16e930` is the correct pre-change reference.

## Method

```
ONLY=all ./ab-run.sh <bundle.js> <tag>            # production-shaped, full 20-server catalogue
       ./ab-run.sh <bundle.js> <tag> <task> <server>   # single backend
```

`ab-run.sh` points one backend's URL at a logging reverse proxy, drives
`initialize → tools/list → tool_hub.resolve → tool_hub.invoke` through the **real** wrapper
(`$PA_REPO/scripts/ccr-toolhub-wrapper.sh`, as `.mcp.json` does) and captures every request the
backend receives. `canon.mjs` reduces a capture to a canonical tuple:

```
<dir> <http> <method> | pv=<mcp-protocol-version> | Mcp-Method | Mcp-Name | _meta | bodySha256 | <all headers>
```

Session ids and host are placeholder-ed as volatile; everything else is compared verbatim.

To keep selection deterministic, `HARNESS_OPENAI_BASE_URL` defaults to a dead port so the resolver
falls back to `retriever: "local"` (task-text scored, not LLM-nondeterministic). Pass an empty
`HARNESS_OPENAI_BASE_URL` to exercise the real LLM retriever instead.

## Cases run — all identical

| case | backend | retriever | catalogue | result |
|---|---|---|---|---|
| pre-change vs live, ×2 each | backend A | local | single | identical |
| build @ `9133c2ca` vs live | backend A | local | single | differs **only** at `initialize` |
| build @ `5d1b4663` vs live | backend A | local | single | differs **only** at `initialize` |
| pre-change vs live | backend B | local | single | identical |
| pre-change vs live | backend A | local | full catalogue | identical |
| pre-change vs live | backend A | **llm** | full catalogue | identical |

The only difference for the two older commits is request #1's body: `initialize`
`capabilities.extensions` goes `{}` → `{"io.modelcontextprotocol/tasks": {}}` (commit `0b16e930`).
Against the bundle that was actually live, even that is identical.

## The legacy sequence (backend A, local retriever)

```
--> POST initialize                 pv=none        Mcp-Method=none Mcp-Name=none  _meta=false
<-- 200
--> POST notifications/initialized  pv=2024-11-05 Mcp-Method=none Mcp-Name=none  _meta=false
<-- 202
--> GET  (SSE stream)               pv=2024-11-05
--> POST tools/list   ×2            pv=2024-11-05 ...
<-- 200
--> POST tools/call                 pv=2024-11-05 ...  bodySha256 identical across bundles
<-- 200
```

With the LLM retriever there is one extra `tools/list` (×3) — again identical across bundles.

No `server/discover`, no `tasks/*`, no `params._meta`, and no `Mcp-Method` / `Mcp-Name` routing
headers on **any** request in **any** capture. `mcp-protocol-version` is the server-echoed
negotiated value: `2024-11-05` for backend A, `2025-11-25` for backend B. The resolver's own
`initialize` *requests* `2025-11-25` in both cases.

## ⚠️ The trap this harness fell into — the proxy must forward headers BOTH ways

There is one proxy, `proxy.mjs`, and it forwards every header untouched in both directions. There is
deliberately **no second, simpler proxy beside it**: an earlier version sat next to the working one
under the *more* obvious name, and that naming inversion — not just the bug — is what cost a day.

The bug, for the record: it rebuilt the upstream response headers with only
`content-type`/`content-length`, so the **`mcp-session-id` response header was dropped**:

```js
clientRes.writeHead(upRes.statusCode, {
  'content-type': upRes.headers['content-type'] || 'application/json',
  'content-length': body.length          // ← mcp-session-id never copied
});
```

A session-based legacy backend then rejects everything after `initialize` with
`422 "Unexpected message, expect initialize request"`, so the probe yields no tools.

With a single-backend catalogue that makes `tool_hub.resolve` answer
`-32603 "No MCP tools are available to resolve."` — even with a warm cache, because the URL repoint
also changes `hashToolHubMcpServerConfig`, and `readDiscovery` (`packages/core/src/mcp/toolhub-mcp.ts:2407`)
*deletes* the mismatched entry. With 20 backends the failure is masked: a dead backend contributes
nothing while the others keep `catalog.length > 0` (`toolhub-mcp.ts:396` is the empty-catalogue guard).

This was mistaken for "a single-server config breaks the resolver, probably a guard or a cache keyed
on the whole list". It is neither. The modern backend is stateless, so it worked fine
through the broken proxy and hid the bug — which is exactly why legacy captures kept stopping at the
handshake.

`ab-run.sh` now asserts the **outcome** — `initialize` reached the backend and no response was
rejected — so this cannot return silently, on any backend, for any reason.

## What this does and does not establish

- **Establishes:** for these invocation shapes, the legacy request sequence is identical in method,
  headers, routing headers and body hash between the pre-change and live bundles.
- **Does not establish:** only one task text per backend was used for the deterministic cases and the
  LLM cases are single runs, so a task-dependent divergence in *selection* is not excluded — only the
  transport leg is. Error/retry legs, a backend returning a task handle (legacy ones cannot),
  `stdio`/`sse` transports (only `streamable-http` was tested) and the modern path were not
  covered. Requests were compared; responses only by status.

## Files

| file | role |
|---|---|
| `ab-run.sh` | one bundle × one backend, through the proxy; `ONLY=all` for the production catalogue. Needs `UPSTREAM_PORT` and a server argument — neither has a default |
| `drive.mjs` | drives the resolver over stdio via the real wrapper. `--server` and `--task` are **required**; `--invoke-args '<json>'` supplies the tool's own arguments (without it the invoke is skipped, because only the caller knows the tool's schema) |
| `proxy.mjs` | transparent logging reverse proxy — forwards headers both ways, which is the whole point |
| `canon.mjs` | capture → canonical comparable tuple |
| `extract.mjs`, `extract-headers.mjs` | coarser method/header views |

Captures (`wire-*.log`), canonical files, rebuilt bundles and toolhub caches are **not** committed —
regenerable via the recipe above.
