import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGateway } from '../dist/gateway.js';
import { loadConfig } from '../dist/config.js';

const token = 'test-local-token';
const body = { model: 'gpt-6-astra', input: 'test', store: false, tools: [{ type: 'function', name: 'read' }], reasoning: { effort: 'high' } };
const decision = { tool: { mode: 'forced', name: 'read', confidence: .99 }, reasoning: { effort: 'low', confidence: .99 } };
const usage = { input_tokens: 90, input_tokens_details: { cached_tokens: 30 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 5 } };
async function setup(t, handler, opts = {}) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const cfg = { ...loadConfig({}), upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/base`, ...opts };
  const gateway = createGateway({ config: cfg, token, engine: opts.engine ?? { decide: async () => decision } });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  t.after(async () => { gateway.server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => gateway.server.close(r)), new Promise(r => upstream.close(r))]); });
  return { ...gateway, url: `http://127.0.0.1:${gateway.server.address().port}` };
}
async function read(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString(); }
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected gateway observation was not recorded');
}
const headers = { 'x-metis-token': token, authorization: 'Bearer existing-codex-login', 'chatgpt-account-id': 'account-1', 'content-type': 'application/json' };

test('auth passthrough, unrelated fields, JSON usage and privacy', async t => {
  let received;
  const gw = await setup(t, async (req, res) => {
    received = { headers: req.headers, body: JSON.parse(await read(req)), url: req.url };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'resp_1', usage }));
  });
  const privateHeaders = { 'x-metis-task-id': 'metis-private-task', 'x-jev-token': 'legacy-private-token', 'x-jev-task-id': 'legacy-private-task' };
  const response = await fetch(`${gw.url}/v1/responses?x=1`, { method: 'POST', headers: { ...headers, ...privateHeaders }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(received.url, '/base/responses?x=1');
  assert.equal(received.headers.authorization, headers.authorization);
  assert.equal(received.headers['chatgpt-account-id'], 'account-1');
  assert.equal(received.headers['x-metis-token'], undefined);
  for (const name of Object.keys(privateHeaders)) assert.equal(received.headers[name], undefined);
  assert.equal(received.body.reasoning.effort, 'low');
  assert.equal(received.body.input, 'test');
  const event = gw.metrics.snapshot().requests.at(-1);
  assert.equal(event.inputTokens, 90); assert.equal(event.reasoningTokens, 5);
  assert.ok(!JSON.stringify(event).includes('existing-codex-login'));
  assert.equal(event.input, undefined);
});

test('400 rewrite rejection retries byte-exact original, including compressed body', async t => {
  for (const compressed of [false, true]) {
    const calls = [];
    const original = JSON.stringify(body, null, 2);
    const bytes = compressed ? gzipSync(original) : Buffer.from(original);
    const gw = await setup(t, async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      calls.push({ body: Buffer.concat(chunks), encoding: req.headers['content-encoding'] });
      res.statusCode = calls.length === 1 ? 400 : 200;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ usage }));
    });
    const response = await fetch(`${gw.url}/v1/responses`, { method: 'POST', headers: { ...headers, ...(compressed ? { 'content-encoding': 'gzip' } : {}) }, body: bytes });
    await response.text();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].body, bytes);
    assert.equal(calls[0].encoding, undefined);
    assert.equal(calls[1].encoding, compressed ? 'gzip' : undefined);
    const metric = gw.metrics.snapshot().requests.at(-1);
    assert.equal(metric.effortApplied, false);
    assert.deepEqual(metric.modelAttempts.map(a => [a.kind, a.status, a.complete]), [['rewrite', 400, true], ['original', 200, true]]);
    assert.equal(metric.inputTokens, 180); assert.equal(metric.outputTokens, 20);
    assert.equal(metric.cachedInputTokens, 60); assert.equal(metric.reasoningTokens, 10);
    assert.equal(gw.metrics.snapshot().usage.model.knownTotalTokens, 200);
  }
});

test('rejected response observation is bounded by time and bytes before fallback', async t => {
  for (const limit of ['time', 'bytes']) {
    let calls = 0; let rejectedClosed = false;
    const gw = await setup(t, async (req, res) => {
      await read(req); calls++; res.setHeader('content-type', 'application/json');
      if (calls === 1) {
        res.statusCode = 422; res.on('close', () => { rejectedClosed = true; });
        if (limit === 'time') res.write('{"usage":');
        else res.end(JSON.stringify({ padding: 'x'.repeat(70 * 1024), usage }));
      } else res.end(JSON.stringify({ usage }));
    });
    const response = await fetch(`${gw.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { usage });
    assert.equal(calls, 2); await waitFor(() => rejectedClosed);
    const metric = gw.metrics.snapshot().requests.at(-1);
    assert.equal(metric.modelAttempts.length, 2);
    assert.equal(metric.modelAttempts[0].complete, false); assert.ok(metric.modelAttempts[0].reasons.length);
    assert.equal(metric.modelAttempts[1].complete, true);
    assert.equal(metric.inputTokens, 90); assert.equal(metric.outputTokens, 10);
    assert.equal(gw.metrics.snapshot().usage.model.complete, false);
  }
});

test('compaction is metered without evaluation or generation-routing observations', async t => {
  let received; let evaluations = 0;
  const gw = await setup(t, async (req, res) => {
    received = { path: req.url, body: await read(req), taskHeader: req.headers['x-metis-task-id'] };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'response.compaction', usage }));
  }, { engine: { decide: async () => { evaluations++; return decision; } } });
  const raw = JSON.stringify(body, null, 2);
  const response = await fetch(`${gw.url}/v1/responses/compact`, { method: 'POST', headers: { ...headers, 'x-metis-task-id': 'compact-task' }, body: raw });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(received, { path: '/base/responses/compact', body: raw, taskHeader: undefined });
  assert.equal(evaluations, 0);
  const metric = gw.metrics.snapshot().requests[0];
  assert.equal(metric.taskId, 'compact-task'); assert.equal(metric.kind, 'compaction');
  assert.equal(metric.inputTokens, 90); assert.equal(metric.modelAttempts[0].complete, true);
  assert.equal(gw.metrics.snapshot().usage.model.knownTotalTokens, 100);
  assert.equal(gw.metrics.observations().retainedRequests, 0);
  assert.equal(gw.metrics.observations().routing.appliedDenominator, 0);
});

test('SSE arrives before completion; multiline and split events yield usage', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const gw = await setup(t, async (req, res) => {
    await read(req); res.setHeader('content-type','text/event-stream');
    res.write('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
    await gate;
    const event = `event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\r\n\r\n`;
    res.write(event.slice(0, 43)); res.end(event.slice(43));
  });
  const response = await fetch(`${gw.url}/v1/responses`, { method:'POST', headers, body:JSON.stringify({ ...body, stream: true }) });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /response.created/);
  release(); while (!(await reader.read()).done) {}
  assert.equal(gw.metrics.snapshot().requests.at(-1).cachedInputTokens, 30);
});

test('local endpoint requires private token and rejects foreign origins', async t => {
  const gw = await setup(t, (_req, res) => res.end('{}'));
  assert.equal((await fetch(`${gw.url}/control/status`)).status, 401);
  assert.equal((await fetch(`${gw.url}/control/status`, { headers: { 'x-metis-token': token, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${gw.url}/control/status`, { headers })).status, 200);
  const r = await fetch(`${gw.url}/control/routing`, { method: 'POST', headers, body: JSON.stringify({ toolRouting: false, effortRouting: true }) });
  assert.equal(r.status, 200);
  const status = await (await fetch(`${gw.url}/control/status`, { headers })).json();
  assert.equal(status.toolRouting, false); assert.equal(status.effortRouting, true);
});

test('direct JSON/SSE uses no upstream and returns a complete function call', async t => {
  let upstreamCalls = 0;
  const direct = { ...decision, tool: { mode:'direct', name:'read', confidence:1, arguments:{kind:'brief'} } };
  const gw = await setup(t, (_req,res) => { upstreamCalls++; res.end('{}'); }, { directCalls:true, engine:{decide:async()=>direct} });
  for (const stream of [false,true]) {
    const req = {...body,stream,tools:[{type:'function',name:'read',parameters:{type:'object',additionalProperties:false,properties:{kind:{enum:['brief','full']}},required:['kind']}}]};
    const response = await fetch(`${gw.url}/v1/responses`,{method:'POST',headers,body:JSON.stringify(req)});
    const data = await response.text();
    const result = stream ? data.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).at(-1).response : JSON.parse(data);
    assert.match(result.id,/^resp_metis_/);
    assert.equal(result.status,'completed');assert.equal(result.output[0].name,'read');
    assert.equal(result.output[0].arguments,'{"kind":"brief"}');assert.equal(result.usage.input_tokens,0);
  }
  assert.equal(upstreamCalls,0);
  assert.ok(gw.metrics.snapshot().requests.every(e=>!e.effortApplied&&e.mode==='direct'));
  for (const metric of gw.metrics.snapshot().requests) { assert.deepEqual(metric.modelAttempts, []); assert.equal(metric.inputTokens, 0); assert.equal(metric.outputTokens, 0); }
  assert.equal(gw.metrics.snapshot().usage.model.complete, true);
  assert.equal(gw.metrics.snapshot().usage.model.knownTotalTokens, 0);
});

test('baseline and provider failure preserve exact bytes; 401 is never retried', async t => {
  for (const settings of [{toolRouting:false,effortRouting:false},{engine:{decide:async()=>{throw Error('provider-secret');}}}]) {
    let calls=0;let received;
    const gw=await setup(t,async(req,res)=>{calls++;received=await read(req);res.statusCode=401;res.end('{"error":"unauthorized"}');},settings);
    const raw=JSON.stringify(body,null,2);
    const response=await fetch(`${gw.url}/v1/responses`,{method:'POST',headers,body:raw});
    assert.equal(response.status,401);await response.text();assert.equal(calls,1);assert.equal(received,raw);
    const metric=gw.metrics.snapshot().requests.at(-1);assert.equal(metric.mode,'passthrough');
    assert.ok(!JSON.stringify(metric).includes('provider-secret'));
  }
});

test('client disconnect cancels the upstream stream', async t => {
  let disconnected;
  const closed=new Promise(r=>{disconnected=r;});
  const gw=await setup(t,async(req,res)=>{await read(req);res.on('close',disconnected);res.setHeader('content-type','text/event-stream');res.write('data: {"type":"response.created"}\n\n');});
  const abort=new AbortController();
  const response=await fetch(`${gw.url}/v1/responses`,{method:'POST',headers,body:JSON.stringify({...body,stream:true}),signal:abort.signal});
  await response.body.getReader().read();abort.abort();
  await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('upstream not cancelled')),2000);timer.unref();})]);
  const metric = await waitFor(() => gw.metrics.snapshot().requests[0]);
  assert.equal(metric.modelAttempts.length, 1); assert.equal(metric.modelAttempts[0].dispatched, true);
  assert.equal(metric.modelAttempts[0].complete, false); assert.ok(metric.modelAttempts[0].reasons.includes('cancelled'));
  assert.equal(metric.inputTokens, undefined); assert.equal(gw.metrics.snapshot().usage.model.knownTotalTokens, undefined);
});

test('cancelling during evaluation records zero model dispatches', async t => {
  let evaluating; let modelCalls = 0;
  const started = new Promise(resolve => { evaluating = resolve; });
  const gw = await setup(t, (_req, res) => { modelCalls++; res.end('{}'); }, {
    engine: { decide: async (_state, signal) => { evaluating(); await once(signal, 'abort'); throw Error('cancelled'); } },
  });
  const abort = new AbortController();
  const pending = fetch(`${gw.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal }).catch(() => {});
  await started; abort.abort(); await pending;
  const metric = await waitFor(() => gw.metrics.snapshot().requests[0]);
  assert.equal(modelCalls, 0); assert.deepEqual(metric.modelAttempts, []);
  assert.equal(metric.inputTokens, 0); assert.equal(metric.outputTokens, 0);
  assert.equal(gw.metrics.snapshot().usage.model.complete, true);
});

test('task registration is authenticated, single-use, and waits for in-flight accounting', async t => {
  let release; let received;
  const upstreamStarted = new Promise(resolve => { received = resolve; });
  const gw = await setup(t, async (req, res) => {
    await read(req); received(); await new Promise(resolve => { release = resolve; });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ usage }));
  }, { toolRouting: false, effortRouting: false });
  const start = { id: 'task-lifecycle', cohort: 'baseline' };
  const post = (path, value, auth = headers) => fetch(`${gw.url}/control/${path}`, { method: 'POST', headers: auth, body: JSON.stringify(value) });
  assert.equal((await post('task/start', start, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await post('task/start', { ...start, id: '../bad' })).status, 400);
  assert.equal((await post('task/start', { ...start, cohort: 'mixed' })).status, 400);
  assert.equal((await post('task/start', { ...start, cohort: ['baseline'] })).status, 400);
  assert.equal((await post('task', { ...start, cohort: ['baseline'], durationMs: 30, exitCode: 0 })).status, 400);
  assert.equal((await post('task/start', start)).status, 200);
  assert.equal((await post('task/start', start)).status, 409);
  const status = await (await fetch(`${gw.url}/control/status`, { headers })).json();
  assert.equal(status.accountingVersion, 1);
  const pending = fetch(`${gw.url}/v1/responses`, { method: 'POST', headers: { ...headers, 'x-metis-task-id': start.id }, body: JSON.stringify(body) });
  await upstreamStarted;
  assert.equal((await post('task', { ...start, durationMs: 30, exitCode: 1 })).status, 200);
  let task = gw.metrics.snapshot().taskUsage.find(task => task.id === start.id);
  assert.equal(task.ended, true); assert.equal(task.activeRequests, 1); assert.equal(task.complete, false);
  release(); await (await pending).text();
  task = gw.metrics.snapshot().taskUsage.find(task => task.id === start.id);
  assert.equal(task.activeRequests, 0); assert.equal(task.complete, true); assert.equal(task.exitCode, 1);
  assert.equal(task.combined.knownTotalTokens, 100);
});

test('an interrupted request body releases task accounting without model dispatch', async t => {
  let calls = 0;
  const gw = await setup(t, (_req, res) => { calls++; res.end('{}'); });
  await fetch(`${gw.url}/control/task/start`, { method: 'POST', headers, body: JSON.stringify({ id: 'body-abort', cohort: 'tool+effort' }) });
  const request = httpRequest(`${gw.url}/v1/responses`, { method: 'POST', headers: { ...headers, 'x-metis-task-id': 'body-abort', 'content-length': '100' } });
  request.on('error', () => {}); request.write('{');
  await waitFor(() => gw.metrics.snapshot().taskUsage.find(task => task.id === 'body-abort')?.activeRequests === 1);
  request.destroy();
  const metric = await waitFor(() => gw.metrics.snapshot().requests[0]);
  assert.equal(gw.metrics.snapshot().taskUsage.find(task => task.id === 'body-abort').activeRequests, 0);
  assert.deepEqual(metric.modelAttempts, []); assert.equal(metric.outcome, 'invalid_request'); assert.equal(calls, 0);
});

test('redirects are not followed with model credentials', async t => {
  let calls=0;
  const gw=await setup(t,(_req,res)=>{calls++;res.writeHead(307,{location:'http://127.0.0.1:1/steal'});res.end();});
  const response=await fetch(`${gw.url}/v1/responses`,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,502);await response.text();assert.equal(calls,1);
});
