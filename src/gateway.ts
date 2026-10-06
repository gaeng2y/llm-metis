import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { Config } from './config.js';
import { object, type DecisionEngine, type JsonObject } from './decision.js';
import { JevDecisionEngine } from './jev.js';
import { control, type RouteResult } from './routing.js';
import { Metrics, UsageObserver, cohort, routeMetric, type Cohort } from './metrics.js';

const LIMIT = 32 * 1024 * 1024;
const hop = ['host','connection','content-length','transfer-encoding','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','upgrade'];
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
};
async function readBody(req: IncomingMessage, max = LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Error('body_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseBody(bytes: Buffer, encoding?: string): JsonObject | undefined {
  try {
    const options = { maxOutputLength: LIMIT };
    const decoded = encoding === 'gzip' ? gunzipSync(bytes, options) : encoding === 'deflate' ? inflateSync(bytes, options) : encoding === 'br' ? brotliDecompressSync(bytes, options) : !encoding || encoding === 'identity' ? bytes : undefined;
    if (!decoded) return;
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    return object(value) ? value : undefined;
  } catch { return; }
}
function equalToken(presented: unknown, token: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function directResponse(request: JsonObject, direct: NonNullable<RouteResult['direct']>) {
  const item = { type: 'function_call', id: `fc_${randomUUID().replaceAll('-','')}`, call_id: `call_${randomUUID().replaceAll('-','')}`, name: direct.name, arguments: JSON.stringify(direct.arguments), status: 'completed' };
  const response = { id: `resp_metis_${randomUUID().replaceAll('-','')}`, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model: request.model,
    error: null, incomplete_details: null, output: [item], store: false, previous_response_id: null,
    parallel_tool_calls: request.parallel_tool_calls ?? true, tools: request.tools ?? [], tool_choice: request.tool_choice ?? 'auto',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!request.stream) return { body: JSON.stringify(response), type: 'application/json' };
  const pending = { ...response, status: 'in_progress', output: [], usage: null };
  const at = { output_index: 0, item_id: item.id };
  const events = [
    { type: 'response.created', response: pending }, { type: 'response.in_progress', response: pending },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', ...at, delta: item.arguments },
    { type: 'response.function_call_arguments.done', ...at, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response },
  ];
  return { body: events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), type: 'text/event-stream' };
}

export function createGateway({ config, token, engine, onStop }: { config: Config; token: string; engine?: DecisionEngine; onStop?: () => void }) {
  if (!token) throw Error('A private local token is required');
  const metrics = new Metrics();
  const evaluator = engine ?? new JevDecisionEngine(config);
  const routing = { toolRouting: config.toolRouting, effortRouting: config.effortRouting };
  const dashboard = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 400, { error: 'Invalid or oversized local request' }); else res.destroy();
    });
  });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUse HTTP/SSE'); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`))) return json(res, 403, { error: 'Local origin required' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      return res.end(dashboard);
    }
    if (!equalToken(req.headers['x-metis-token'], token)) return json(res, 401, { error: 'Private local token required' });
    if (url.pathname === '/control/status' && req.method === 'GET') return json(res, 200, { service: 'llm-metis', version: '0.1.0', pid: process.pid, ...routing, upstream: config.upstreamBaseUrl, provider: config.provider, jevConfigured: Boolean(config.jevApiKey), directCalls: config.directCalls });
    if (url.pathname === '/control/metrics' && req.method === 'GET') return json(res, 200, metrics.snapshot());
    if (url.pathname === '/control/routing' && req.method === 'POST') {
      const value = parseBody(await readBody(req, 4096));
      if (!value || Object.keys(value).some(k => !['toolRouting','effortRouting'].includes(k)) || Object.values(value).some(v => typeof v !== 'boolean')) return json(res, 400, { error: 'Boolean toolRouting/effortRouting required' });
      Object.assign(routing, value); return json(res, 200, routing);
    }
    if (url.pathname === '/control/task' && req.method === 'POST') {
      const value = parseBody(await readBody(req, 4096));
      if (!value || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id) || !['baseline','tool-only','effort-only','tool+effort'].includes(String(value.cohort)) || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || !(value.exitCode === null || Number.isInteger(value.exitCode))) return json(res, 400, { error: 'Invalid task metric' });
      metrics.addTask({ id: value.id, cohort: value.cohort as Cohort, durationMs: value.durationMs, exitCode: value.exitCode as number | null }); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/control/stop' && req.method === 'POST' && onStop) { json(res, 200, { stopping: true }); setImmediate(onStop); return; }
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '');
    if (!(req.method === 'POST' && ['/responses','/responses/compact'].includes(path)) && !(req.method === 'GET' && path === '/models')) return json(res, 404, { error: 'Unsupported endpoint' });
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const started = performance.now();
    const bytes = req.method === 'POST' ? await readBody(req) : undefined;
    const parsed = bytes ? parseBody(bytes, req.headers['content-encoding']) : undefined;
    const cfg = { ...config, ...routing };
    let route: RouteResult = { request: parsed ?? {}, mode: 'passthrough', reason: 'unrouted_endpoint', effortApplied: false, jevCalled: false, jevLatencyMs: 0 };
    if (path === '/responses' && parsed) {
      if (engine || config.jevApiKey) route = await control(parsed, evaluator, cfg, abort.signal);
      else route.reason = 'jev_credentials_missing';
    }
    const modelStarted = performance.now();
    let status = 502; let outcome = 'upstream_error';
    let observer: UsageObserver | undefined;
    let modelLatencyMs = 0;
    const isGeneration = path === '/responses';
    try {
      if (abort.signal.aborted) throw Error('cancelled');
      if (route.direct) {
        const direct = directResponse(parsed!, route.direct);
        observer = new UsageObserver(Boolean(parsed!.stream)); observer.write(Buffer.from(direct.body)); observer.finish();
        res.writeHead(200, { 'content-type': direct.type, 'cache-control': 'no-store' });
        res.end(direct.body); status = 200; outcome = 'completed';
      } else {
        let rewrittenBody: string | undefined;
        if (parsed !== undefined && route.request !== parsed) {
          try { rewrittenBody = JSON.stringify(route.request); }
          catch { route = { ...route, request: parsed, mode: 'passthrough', effortApplied: false, reason: 'rewrite_failed' }; }
        }
        const send = (rewrite: boolean) => {
          const headers = new Headers();
          const dropped = new Set([...hop, ...(req.headers.connection ?? '').toLowerCase().split(',').map(v => v.trim()), 'accept-encoding','origin','referer']);
          for (const [key, value] of Object.entries(req.headers)) if (!dropped.has(key) && !key.startsWith('x-metis-') && !key.startsWith('x-jev-') && !key.startsWith('sec-') && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          if (rewrite) headers.delete('content-encoding');
          return fetch(`${config.upstreamBaseUrl}${path}${url.search}`, { method: req.method, headers,
            body: rewrite ? rewrittenBody : bytes ? new Uint8Array(bytes) : undefined, signal: abort.signal, redirect: 'error' });
        };
        const rewritten = parsed !== undefined && route.request !== parsed;
        let upstream = await send(rewritten);
        if (rewritten && [400,422].includes(upstream.status)) {
          await upstream.body?.cancel();
          route = { ...route, request: parsed!, mode: 'passthrough', effortApplied: false, reason: 'upstream_rejected_rewrite' };
          upstream = await send(false);
        }
        status = upstream.status;
        const responseHeaders: Record<string, string> = {};
        const dropped = new Set([...hop, 'content-encoding', ...(upstream.headers.get('connection') ?? '').toLowerCase().split(',').map(v => v.trim())]);
        upstream.headers.forEach((v, k) => { if (!dropped.has(k) && !k.startsWith('access-control-')) responseHeaders[k] = v; });
        res.writeHead(status, responseHeaders);
        const isSSE = upstream.headers.get('content-type')?.includes('text/event-stream') ?? false;
        observer = new UsageObserver(isSSE);
        if (upstream.body) for await (const chunk of upstream.body) {
          observer.write(chunk);
          if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
        }
        observer.finish();
        outcome = upstream.ok ? observer.outcome === 'unknown' ? isSSE ? 'incomplete_stream' : 'completed' : observer.outcome : 'http_error';
        res.end();
        modelLatencyMs = performance.now() - modelStarted;
      }
    } catch {
      modelLatencyMs = performance.now() - modelStarted;
      outcome = observer?.outcome === 'completed' ? 'completed' : abort.signal.aborted ? 'cancelled' : 'upstream_error';
      if (!res.headersSent && !res.destroyed) json(res, 502, { error: 'Upstream transport failed' });
      else if (!res.writableEnded) res.destroy();
    } finally {
      if (isGeneration) {
        const task = req.headers['x-metis-task-id'];
        metrics.add({ id: randomUUID(), time: new Date().toISOString(), cohort: cohort(cfg), model: typeof parsed?.model === 'string' ? parsed.model.slice(0, 100) : '',
          taskId: typeof task === 'string' && /^[\w-]{1,80}$/.test(task) ? task : undefined,
          ...routeMetric(route, cfg), ...observer?.usage, modelLatencyMs, requestLatencyMs: performance.now() - started, status, outcome });
      }
    }
  }
  return { server, metrics };
}
