// Canonical comparison form for a capture: one line per request the backend
// received, with the acceptance fields, the full header set (session id
// placeholder-ed, host normalised) and the sha256 of the body. Volatile
// transport values are excluded so two runs are comparable.
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
    lines.push(
      `#${n} ${r.http} ${r.url} method=${r.method} | pv=${r.protocolVersion ?? 'none'}` +
      ` | Mcp-Method=${r.mcpMethod ?? 'none'} | Mcp-Name=${r.mcpName ?? 'none'}` +
      ` | _meta=${r.hasParamsMeta} | bodySha256=${r.bodySha256 ?? 'none'} | ${headers.join(' ')}`
    );
  }
  const out = `${file}.canon`;
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${file}: ${lines.length} requests -> ${out}`);
}
