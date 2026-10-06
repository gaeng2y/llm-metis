import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGateway } from '../dist/gateway.js';
import { loadConfig } from '../dist/config.js';
import { control } from '../dist/routing.js';

const token = 'a'.repeat(64);
const headers = { 'x-metis-token': token, authorization: 'Bearer existing-claude-login', 'x-api-key': 'existing-anthropic-key',
  'anthropic-beta': 'oauth-2025-04-20,unknown-future-beta', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
const body = { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'Read package.json' }],
  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true }, output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  metadata: { user_id: 'client-user' }, future_field: { keep: true } };
const decision = { tool: { mode: 'forced', name: 'Read', confidence: .99 }, reasoning: { effort: 'low', confidence: .99 } };
const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn',
  usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 9 } };
async function read(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
async function setup(t, handler, options = {}) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  let engineCalls = 0;
  const engine = { decide: async (...args) => { engineCalls++; return options.engine ? options.engine.decide(...args) : decision; } };
  const config = { ...loadConfig({}), upstreamBaseUrl: `${origin}/openai-upstream`, anthropicBaseUrl: `${origin}/anthropic-upstream`, ...options };
  const gateway = createGateway({ config, token, engine });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  t.after(async () => {
    gateway.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  return { ...gateway, url: `http://127.0.0.1:${gateway.server.address().port}`, calls: () => engineCalls };
}
const send = (gateway, payload = JSON.stringify(body), extraHeaders = {}, path = '/anthropic/v1/messages') =>
  fetch(`${gateway.url}${path}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: payload });
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

test('Claude URL authentication is limited to Messages endpoints and stays out of upstream paths and metrics', async t => {
  const paths = [];
  const gw = await setup(t, async (req, res) => {
    paths.push(req.url); await read(req);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message));
  }, { toolRouting: false, effortRouting: false });
  const base = `${gw.url}/anthropic/${token}/private-session`;
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  for (const path of ['/v1/messages?beta=true', '/v1/messages/count_tokens']) {
    const response = await fetch(base + path, request);
    assert.equal(response.status, 200); await response.text();
  }
  assert.deepEqual(paths, ['/anthropic-upstream/v1/messages?beta=true', '/anthropic-upstream/v1/messages/count_tokens']);
  assert.equal((await fetch(base + '/control/status')).status, 401);
  assert.equal((await fetch(base.replace(token, 'b'.repeat(64)) + '/v1/messages', request)).status, 401);
  assert.equal((await fetch(base + '/v1/messages', { ...request, headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal(paths.length, 2); assert.equal(gw.calls(), 0);
  assert.equal(gw.metrics.snapshot().requests[0].taskId, 'private-session');
  assert.ok(!JSON.stringify(gw.metrics.snapshot()).includes(token));
});

test('Messages uses the Anthropic upstream, one evaluator call, native rewrites and unchanged authentication', async t => {
  let received;
  const gw = await setup(t, async (req, res) => {
    received = { path: req.url, headers: req.headers, body: JSON.parse((await read(req)).toString()) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message));
  });
  const privateHeaders = { 'x-metis-task-id': 'claude-task', 'x-metis-private': 'local-only', 'x-jev-token': 'legacy-token', 'x-jev-extra': 'legacy-only' };
  const response = await send(gw, JSON.stringify(body), privateHeaders, '/anthropic/v1/messages?beta=true');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), message);
  assert.equal(received.path, '/anthropic-upstream/v1/messages?beta=true');
  for (const name of ['authorization', 'x-api-key', 'anthropic-beta', 'anthropic-version']) assert.equal(received.headers[name], headers[name]);
  for (const name of ['x-metis-token', ...Object.keys(privateHeaders)]) assert.equal(received.headers[name], undefined);
  assert.deepEqual(received.body, { ...body, tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true }, output_config: { ...body.output_config, effort: 'low' } });
  assert.equal(gw.calls(), 1);
  const metric = gw.metrics.snapshot().requests.at(-1);
  assert.equal(metric.taskId, 'claude-task'); assert.equal(metric.mode, 'forced'); assert.equal(metric.appliedEffort, 'low');
  assert.equal(metric.inputTokens, 60); assert.equal(metric.cachedInputTokens, 30); assert.equal(metric.outputTokens, 9); assert.equal(metric.outcome, 'completed');
  assert.doesNotMatch(JSON.stringify(metric), /existing-claude-login|existing-anthropic-key|Read package|local-only/);
});

test('Messages honors thinking and caller constraints, never synthesizes direct calls, and gates effort independently', async () => {
  let calls = 0;
  const engine = { decide: async () => { calls++; return decision; } };
  for (const change of [{ thinking: { type: 'adaptive' } }, { thinking: { type: 'enabled', budget_tokens: 1024 } }, { model: 'claude-opus-5-5' }, { tool_choice: { type: 'tool', name: 'Read' } }]) {
    const input = { ...body, ...change };
    const result = await control(input, engine, loadConfig({}), undefined, 'messages');
    assert.deepEqual(result.request.tool_choice, input.tool_choice);
    assert.deepEqual(result.request.output_config, { ...body.output_config, effort: 'low' });
    assert.deepEqual(result.request.thinking, input.thinking);
    assert.equal(result.mode, 'passthrough');
  }
  assert.equal(calls, 4);
  const direct = await control({ ...body, store: false }, { decide: async () => ({ ...decision, tool: { ...decision.tool, mode: 'direct', arguments: {} } }) }, { ...loadConfig({}), directCalls: true }, undefined, 'messages');
  assert.equal(direct.direct, undefined); assert.equal(direct.mode, 'forced'); assert.equal(direct.request.tool_choice.type, 'tool');
  const noEffort = await control({ ...body, output_config: { format: body.output_config.format } }, engine, loadConfig({}), undefined, 'messages');
  assert.equal(noEffort.effortApplied, false); assert.equal(noEffort.request.output_config.effort, undefined);
  const noTool = await control(body, { decide: async () => ({ ...decision, tool: { mode: 'none', confidence: 1 } }) }, loadConfig({}), undefined, 'messages');
  assert.deepEqual(noTool.request.tool_choice, { type: 'none' });
});

test('Messages retries rejected rewrites once with exact original bytes and encoding', async t => {
  for (const [status, compressed] of [[400, false], [422, true]]) {
    const received = [];
    const gw = await setup(t, async (req, res) => {
      received.push({ bytes: await read(req), encoding: req.headers['content-encoding'] });
      res.statusCode = received.length === 1 ? status : 200; res.end(JSON.stringify(message));
    });
    const original = JSON.stringify(body, null, 2);
    const bytes = compressed ? gzipSync(original) : Buffer.from(original);
    const response = await send(gw, bytes, compressed ? { 'content-encoding': 'gzip' } : {});
    assert.equal(response.status, 200); await response.text();
    assert.equal(received.length, 2); assert.equal(gw.calls(), 1);
    assert.equal(JSON.parse(received[0].bytes.toString()).output_config.effort, 'low');
    assert.equal(received[0].encoding, undefined);
    assert.deepEqual(received[1].bytes, bytes); assert.equal(received[1].encoding, compressed ? 'gzip' : undefined);
    const metric = gw.metrics.snapshot().requests.at(-1);
    assert.equal(metric.reason, 'upstream_rejected_rewrite'); assert.equal(metric.effortApplied, false); assert.equal(metric.appliedEffort, 'high');
  }
});

test('Messages baseline and evaluator failures preserve bytes; unauthorized upstream is never retried', async t => {
  for (const options of [{ toolRouting: false, effortRouting: false }, { engine: { decide: async () => { throw Error('provider-secret'); } } }, {}]) {
    const received = [];
    const gw = await setup(t, async (req, res) => { received.push(await read(req)); res.statusCode = 401; res.end('{"type":"error","error":{"type":"authentication_error"}}'); }, options);
    const bytes = Buffer.from(JSON.stringify(body, null, 2));
    const response = await send(gw, bytes);
    assert.equal(response.status, 401); await response.text(); assert.equal(received.length, 1);
    if (Object.keys(options).length) assert.deepEqual(received[0], bytes);
    assert.equal(gw.calls(), options.toolRouting === false ? 0 : 1);
    assert.equal(gw.metrics.snapshot().requests.at(-1).outcome, 'http_error');
    assert.doesNotMatch(JSON.stringify(gw.metrics.snapshot()), /provider-secret/);
  }
});

test('Messages streams before completion and observes cumulative usage without changing SSE bytes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const start = `event: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":${JSON.stringify({ ...message, stop_reason: null, content: [], usage: { ...message.usage, output_tokens: 1 } })}}\r\n\r\n`;
  const end = event({ type: 'ping' }) + event({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } }) +
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 12, cache_read_input_tokens: 40, output_tokens: 9 } }) + event({ type: 'message_stop' });
  const gw = await setup(t, async (req, res) => {
    await read(req); res.setHeader('content-type', 'text/event-stream'); res.write(start);
    await gate; res.write(end.slice(0, 43)); res.end(end.slice(43));
  });
  const response = await send(gw, JSON.stringify({ ...body, stream: true }));
  const reader = response.body.getReader(); const chunks = [(await reader.read()).value];
  assert.match(Buffer.from(chunks[0]).toString(), /message_start/); release();
  for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  assert.equal(Buffer.concat(chunks).toString(), start + end);
  const metric = gw.metrics.snapshot().requests.at(-1);
  assert.equal(metric.inputTokens, 72); assert.equal(metric.cachedInputTokens, 40); assert.equal(metric.outputTokens, 9); assert.equal(metric.outcome, 'completed');
});

test('Messages streaming errors and missing final events cannot report success', async t => {
  const start = event({ type: 'message_start', message: { ...message, stop_reason: null } });
  for (const [ending, outcome] of [
    [event({ type: 'error', error: { type: 'overloaded_error', message: 'Busy' } }) + event({ type: 'message_stop' }), 'failed'],
    ['', 'incomplete_stream'],
    [event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }), 'incomplete_stream'],
    [event({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1000 } }) + event({ type: 'message_stop' }), 'incomplete'],
  ]) {
    const gw = await setup(t, async (req, res) => { await read(req); res.setHeader('content-type', 'text/event-stream'); res.end(start + ending); });
    const response = await send(gw, JSON.stringify({ ...body, stream: true }));
    assert.equal(await response.text(), start + ending);
    assert.equal(gw.metrics.snapshot().requests.at(-1).outcome, outcome);
  }
});

test('Messages count_tokens passes through unchanged without evaluator calls or generation metrics', async t => {
  let received;
  const gw = await setup(t, async (req, res) => { received = { path: req.url, bytes: await read(req) }; res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":123}'); });
  const bytes = Buffer.from(JSON.stringify(body, null, 2));
  const response = await send(gw, bytes, {}, '/anthropic/v1/messages/count_tokens?beta=true');
  assert.deepEqual(await response.json(), { input_tokens: 123 });
  assert.equal(received.path, '/anthropic-upstream/v1/messages/count_tokens?beta=true'); assert.deepEqual(received.bytes, bytes);
  assert.equal(gw.calls(), 0); assert.deepEqual(gw.metrics.snapshot().requests, []);
});
