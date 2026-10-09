// Drive a toolhub resolver bundle over stdio, using the env the fleet actually
// emits, so two bundles can be compared at the wire.
//
// Usage:
//   node drive.mjs <bundle.js> [--server <name>] [--url <url>] [--task <text>] [--skip-invoke]
//
// The real TOOLHUB_MCP_SERVERS_JSON is read from $PA_REPO/.mcp.json and copied
// verbatim, except that the named server's url is repointed (normally at the
// logging proxy) so its wire can be observed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const bundle = process.argv[2];
if (!bundle || bundle.startsWith('--')) {
  console.error("usage: node drive.mjs <bundle.js> --server <name> --task <text> [--url <url>] [--invoke-args '<json>'] [--skip-invoke]");
  process.exit(2);
}
// ⚠️ --server and --task are REQUIRED and have no defaults, deliberately. A default
// naming one product, or a default task string, bakes a single fleet's setup into a
// generic harness AND can silently point a run at the wrong backend. The caller says
// what is under test.
const targetServer = flag('server', '');
const targetUrl = flag('url', undefined);
const taskText = flag('task', '');
const invokeArgsRaw = flag('invoke-args', '');
const skipInvoke = process.argv.includes('--skip-invoke');
if (!targetServer || !taskText) {
  console.error('drive.mjs: --server <name> and --task <text> are both required');
  process.exit(2);
}

const PA_REPO = process.env.PA_REPO || path.join(os.homedir(), 'Projects', 'personal-assistant');
const mcpJson = JSON.parse(fs.readFileSync(path.join(PA_REPO, '.mcp.json'), 'utf8'));
const servers = JSON.parse(mcpJson.mcpServers['ccr-toolhub'].env.TOOLHUB_MCP_SERVERS_JSON);
// --only restricts the catalog to a single backend. Both bundles get the SAME
// restricted config, so the wire comparison is unaffected — and it removes the
// LLM's freedom to pick some other server's tool, which made an earlier attempt
// compare nothing but the handshake.
const only = flag('only', undefined);
if (only) {
  const kept = servers.filter((s) => s.name === only);
  if (kept.length === 0) {
    console.error(`[drive] --only ${only}: no such server`);
    process.exit(2);
  }
  servers.length = 0;
  servers.push(...kept);
}

if (targetUrl) {
  const entry = servers.find((s) => s.name === targetServer);
  if (!entry) {
    console.error(`[drive] no server named "${targetServer}" in TOOLHUB_MCP_SERVERS_JSON`);
    process.exit(2);
  }
  entry.url = targetUrl;
}

// ⚠️ Spawn through the REAL wrapper, exactly as `.mcp.json` does. It resolves the
// gateway key itself (Keychain, then ~/.authinfo.gpg) and execs node with it.
// Reading the key here instead would be a different code path from production —
// and a missing key degrades the resolver to `retriever: "local"` SILENTLY, which
// is how an earlier run of this harness looked fine while selecting nothing useful.
const WRAPPER = path.join(PA_REPO, 'scripts', 'ccr-toolhub-wrapper.sh');

const env = {
  ...process.env,
  ...mcpJson.mcpServers['ccr-toolhub'].env,
  TOOLHUB_MCP_SERVERS_JSON: JSON.stringify(servers),
  TOOLHUB_CACHE_FILE: process.env.HARNESS_CACHE || '/tmp/stdio-harness/toolhub-cache.json',
  // Applied AFTER the .mcp.json spread (which would otherwise win). Pointing the
  // resolve LLM at a dead port makes the resolver fall back to `retriever: "local"`,
  // which is DETERMINISTIC — the LLM's freedom to pick a different tool each run is
  // what made this comparison impossible to complete.
  ...(process.env.HARNESS_OPENAI_BASE_URL ? { TOOLHUB_OPENAI_BASE_URL: process.env.HARNESS_OPENAI_BASE_URL } : {})
};

console.error(`[drive] bundle=${bundle} (${fs.statSync(bundle).size} bytes)`);
console.error(`[drive] ${targetServer} -> ${targetUrl ?? '(real .mcp.json value)'}`);

const child = spawn(WRAPPER, [bundle], { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(`[resolver stderr] ${d}`));

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('[drive] non-JSON on stdout:', line.slice(0, 200));
      continue;
    }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
  }
});

let nextId = 1;
function call(method, params, timeoutMs = 600_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdio-harness', version: '1.0.0' } });
  console.log('INITIALIZE:', JSON.stringify(init.result?.serverInfo ?? init));

  const tools = await call('tools/list', {});
  console.log('TOOLS:', JSON.stringify((tools.result?.tools ?? []).map((t) => t.name)));

  const resolved = await call('tools/call', { name: 'tool_hub.resolve', arguments: { task: taskText } });
  if (process.env.HARNESS_DEBUG) console.log('RESOLVE full response:', JSON.stringify(resolved).slice(0, 900));
  const text = (resolved.result ?? resolved.error)?.content?.[0]?.text ?? '';
  let names = [];
  let retriever;
  try {
    const parsed = JSON.parse(text);
    retriever = parsed.retriever;
    names = parsed.selectedToolNames ?? (parsed.selectedTools ?? []).map((t) => t.toolName ?? t.alias ?? t);
  } catch { /* not JSON */ }
  console.log('RESOLVE retriever:', retriever);
  console.log('RESOLVE selectedToolNames:', JSON.stringify(names));
  if (!names.length) console.log('RESOLVE raw (first 600):', text.slice(0, 600));

  const needle = targetServer.replace(/-/g, '_');
  const target = names.find((n) => String(n).includes(needle) || String(n).includes(targetServer));
  console.log('TARGET:', target ?? `(none — the task did not select a ${targetServer} tool)`);

  if (target && !skipInvoke) {
    // ⚠️ The tool's OWN arguments come from the caller. Deriving them from the tool
    // name coupled this harness to one product's schema, and a tool whose argument
    // happens to be named differently simply failed with a deserialize error.
    if (!invokeArgsRaw) {
      console.log("INVOKE skipped: pass --invoke-args '{\"<arg>\":\"<value>\"}' with the tool's real arguments");
    } else {
      let invokeArgs;
      try {
        invokeArgs = JSON.parse(invokeArgsRaw);
      } catch (error) {
        console.error('drive.mjs: --invoke-args must be valid JSON —', error?.message ?? error);
        process.exit(2);
      }
      const invoked = await call('tools/call', { name: 'tool_hub.invoke', arguments: { tool: target, args: invokeArgs } });
      const out = invoked.result ?? invoked.error;
      console.log('INVOKE isError:', out?.isError ?? false);
      console.log('INVOKE text (first 300):', String(out?.content?.[0]?.text ?? JSON.stringify(out)).slice(0, 300));
    }
  }
} catch (error) {
  console.error('[drive] FAILED:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill('SIGKILL'), 1500).unref();
}
