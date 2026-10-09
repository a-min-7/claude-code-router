// Canonical, order-stable rendering of every request the backend received,
// including the FULL header set. `mcp-session-id` is volatile (server-assigned
// per session) and is replaced by a placeholder; everything else is compared
// verbatim. `host` is normalised because the proxy rewrites host:port.
import fs from 'node:fs';

const VOLATILE = new Set(['mcp-session-id', 'host']);

for (const file of process.argv.slice(2)) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lines = [];
  let n = 0;
  for (const r of rows) {
    if (r.dir !== '-->') continue;
    n += 1;
    const headers = Object.entries(r.headers ?? {})
      .map(([k, v]) => [k, VOLATILE.has(k) ? `<${k}>` : v])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    lines.push(`#${n} ${r.http} ${r.url} ${r.method} :: ${headers.join(' ')}`);
  }
  fs.writeFileSync(`${file}.reqs`, lines.join('\n') + '\n');
  console.log(`${file}: ${lines.length} requests -> ${file}.reqs`);
}
