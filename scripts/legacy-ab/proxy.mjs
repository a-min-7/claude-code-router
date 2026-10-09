// Transparent logging reverse proxy: forwards EVERY header untouched, in BOTH
// directions, and logs at 'request' time so no request can go unlogged.
//
// ⚠️ There is deliberately no second, simpler proxy beside this one. An earlier
// version rebuilt the upstream response headers and dropped `mcp-session-id`,
// which made every session-based backend reject everything after `initialize`
// with 422 while still producing a full-looking capture. One proxy, no choice to
// make wrongly. `ab-run.sh` asserts that outcome, so the mistake cannot return
// silently.
//
//   UPSTREAM_PORT=<port> PROXY_PORT=8291 PROXY_LOG=/path/to.log node proxy.mjs
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

if (!process.env.UPSTREAM_PORT) { console.error('proxy.mjs: UPSTREAM_PORT is required'); process.exit(2); }
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.UPSTREAM_PORT) };
const PORT = Number(process.env.PROXY_PORT || 8291);
const LOG = process.env.PROXY_LOG || '/tmp/stdio-harness/wire2.log';

fs.writeFileSync(LOG, '');
function note(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => {
    const raw = Buffer.concat(chunks);
    let method = '(no body)';
    let params = undefined;
    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        method = body.method ?? '(unnamed)';
        params = body.params;
      } catch {
        method = '(unparseable)';
      }
    }

    note({
      at: new Date().toISOString(),
      dir: '-->',
      http: clientReq.method,
      url: clientReq.url,
      method,
      mcpMethod: clientReq.headers['mcp-method'] ?? null,
      mcpName: clientReq.headers['mcp-name'] ?? null,
      protocolVersion: clientReq.headers['mcp-protocol-version'] ?? null,
      hasParamsMeta: Boolean(params?._meta),
      bodySha256: raw.length ? createHash('sha256').update(raw).digest('hex') : null,
      body: raw.length ? raw.toString('utf8') : null,
      paramsKeys: params && typeof params === 'object' ? Object.keys(params) : null,
      headers: clientReq.headers
    });

    const headers = { ...clientReq.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
    delete headers['transfer-encoding'];
    if (raw.length) headers['content-length'] = String(raw.length);

    const upstream = http.request(
      { host: UPSTREAM.host, port: UPSTREAM.port, path: clientReq.url, method: clientReq.method, headers },
      (upRes) => {
        const out = [];
        upRes.on('data', (c) => out.push(c));
        upRes.on('end', () => {
          const body = Buffer.concat(out);
          note({
            at: new Date().toISOString(),
            dir: '<--',
            http: clientReq.method,
            method,
            responseStatus: upRes.statusCode,
            // Recorded so the capture itself shows whether the handshake actually
            // established a session — the dropped-header bug was invisible without it.
            mcpSessionId: upRes.headers['mcp-session-id'] ?? null,
            responsePrefix: body.toString('utf8').slice(0, 300)
          });
          const responseHeaders = { 'content-type': upRes.headers['content-type'] || 'application/json', 'content-length': String(body.length) };
          if (upRes.headers['mcp-session-id']) responseHeaders['mcp-session-id'] = upRes.headers['mcp-session-id'];
          clientRes.writeHead(upRes.statusCode ?? 502, responseHeaders);
          clientRes.end(body);
        });
      }
    );
    upstream.on('error', (error) => {
      note({ at: new Date().toISOString(), dir: '<--', method, proxyError: String(error) });
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: String(error) } }));
    });
    upstream.end(raw);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[proxy] 127.0.0.1:${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}, log ${LOG}`);
});
