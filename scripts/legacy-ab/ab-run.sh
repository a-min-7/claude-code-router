#!/usr/bin/env bash
# Run one resolver bundle against ONE legacy backend through the logging proxy,
# and capture the legacy backend's request sequence.
#
#   ab-run.sh <bundle.js> <tag> [task-text] [server]
#
# The proxied server is repointed only for the target backend; --only restricts
# the catalog to that same backend, so selection cannot drift to another server.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$1"; TAG="$2"
TASK="${3:-Search the web for the latest news about the Model Context Protocol specification and summarise it.}"
SERVER="${4:?usage: ab-run.sh <bundle.js> <tag> <task-text> <server>}"
UPSTREAM_PORT="${UPSTREAM_PORT:?set UPSTREAM_PORT to the backend under test (no default: it is fleet topology)}"
PROXY_PORT="${PROXY_PORT:-8291}"
NODE="${NODE:-/opt/homebrew/bin/node}"

CACHE="$DIR/cache-$TAG.json"; rm -f "$CACHE"
LOG="$DIR/wire-$TAG.log"; rm -f "$LOG"

# One proxy, forwarding headers both ways. There is deliberately no simpler
# alternative beside it to pick by mistake — see FINDINGS.md.
UPSTREAM_PORT="$UPSTREAM_PORT" PROXY_PORT="$PROXY_PORT" PROXY_LOG="$LOG" \
  "$NODE" "$DIR/proxy.mjs" 2>"$DIR/proxy-$TAG.err" &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null' EXIT

for _ in $(seq 1 60); do nc -z 127.0.0.1 "$PROXY_PORT" 2>/dev/null && break; sleep 0.1; done

# ONLY=<server> restricts the catalog to that one backend (obstacle-#1 workaround).
# ONLY=all keeps the real 20-server catalog, i.e. the production shape.
ONLY="${ONLY:-$SERVER}"
ONLY_ARG=()
[ "$ONLY" != "all" ] && ONLY_ARG=(--only "$ONLY")

# Dead-port LLM => retriever falls back to "local", which is deterministic.
# `-` not `:-`: an explicitly EMPTY value means "use the real .mcp.json LLM base
# URL", i.e. exercise the llm retriever rather than the local fallback.
HARNESS_CACHE="$CACHE" HARNESS_OPENAI_BASE_URL="${HARNESS_OPENAI_BASE_URL-http://127.0.0.1:9/v1}" \
  "$NODE" "$DIR/drive.mjs" "$BUNDLE" \
    "${ONLY_ARG[@]}" --server "$SERVER" --url "http://127.0.0.1:$PROXY_PORT/mcp" --task "$TASK" \
    >"$DIR/run-$TAG.out" 2>"$DIR/run-$TAG.err"

kill "$PROXY_PID" 2>/dev/null
wait "$PROXY_PID" 2>/dev/null
echo "--- $TAG: $(wc -l <"$LOG" | tr -d ' ') log lines, $(stat -f %z "$BUNDLE") byte bundle ---"

# --- guard: a capture whose handshake did not work is worthless --------------------
# ⚠️ This harness was once blocked for a day by a proxy that dropped
# `mcp-session-id`. The backend then rejects everything AFTER `initialize` with 422,
# the probe yields no tools — and the run still writes a full-looking log, so reading
# it as a result is the failure. The assertion is on the OUTCOME (the handshake
# worked), not on one mechanism, so any future proxy breakage trips it on any backend.
if ! grep -q '"method":"initialize"' "$LOG"; then
  echo "GUARD FAILED: no initialize reached the backend — $LOG is not a usable capture" >&2
  exit 1
fi
REJECTED=$(grep -c '"responseStatus":[45][0-9][0-9]' "$LOG" 2>/dev/null || true)
if [ "${REJECTED:-0}" != "0" ]; then
  echo "GUARD FAILED: ${REJECTED} rejected (4xx/5xx) response(s) — the legacy handshake did not work:" >&2
  grep '"responseStatus":[45][0-9][0-9]' "$LOG" 2>/dev/null | head -2 >&2
  echo "  A proxy that drops mcp-session-id produces exactly this; see FINDINGS.md." >&2
  exit 1
fi
SESSIONS=$(grep -c '"mcpSessionId":"' "$LOG" 2>/dev/null || true)
echo "  guard OK: initialize reached the backend; 0 rejected responses; ${SESSIONS:-0} session-id(s) seen"
