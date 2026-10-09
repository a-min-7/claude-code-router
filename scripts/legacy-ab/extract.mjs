// Normalise a proxy log to the acceptance tuple:
//   dir http method  mcp-protocol-version  Mcp-Method  Mcp-Name  [status]
// Timestamps, session ids and the SSE `id: n/m` counters are volatile and are
// deliberately excluded; the raw prefix is kept separately for eyeballing.
import fs from 'node:fs';

for (const file of process.argv.slice(2)) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const out = rows.map((r) => {
    const parts = [r.dir, r.http ?? '-', r.method ?? '-'];
    parts.push(`pv=${r.protocolVersion ?? 'none'}`);
    parts.push(`Mcp-Method=${r.mcpMethod ?? 'none'}`);
    parts.push(`Mcp-Name=${r.mcpName ?? 'none'}`);
    if (r.dir === '<--') parts.push(`status=${r.responseStatus ?? r.proxyError ?? '?'}`);
    return parts.join(' ');
  });
  console.log(`### ${file}`);
  out.forEach((line) => console.log(line));
  console.log('');
}
