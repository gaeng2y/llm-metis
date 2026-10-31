import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics, UsageObserver, observeDiscardedUsage, summarizeUsage, usageRecord } from '../dist/metrics.js';

const attempt = (input=10, output=2) => ({ dispatched: true, status: 200, ...usageRecord({ input_tokens: input, output_tokens: output }, 'responses') });
const event = (taskId, changes={}) => ({ id: 'request', time: '2026-10-16T00:00:00Z', cohort: 'baseline', model: 'fixture', taskId,
  mode: 'passthrough', reason: 'routing_disabled', effortApplied: false, jevProvider: 'fixture', jevModel: 'fixture', jevCalled: false,
  jevLatencyMs: 0, modelLatencyMs: 1, requestLatencyMs: 1, status: 200, outcome: 'completed', modelAttempts: [attempt()], ...changes });
const end = (id, cohort='baseline', exitCode=0) => ({ id, cohort, durationMs: 10, exitCode });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

test('provider totals retain cache and reasoning breakdowns without double counting', () => {
  const anthropic = usageRecord({ input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 }, output_tokens: 9,
    output_tokens_details: { thinking_tokens: 3 } }, 'messages');
  assert.equal(anthropic.complete, true);
  assert.deepEqual(anthropic.usage, { inputTokens: 60, uncachedInputTokens: 10, cachedInputTokens: 30, cacheWriteInputTokens: 20,
    cacheWrite5mInputTokens: 5, cacheWrite1hInputTokens: 15, outputTokens: 9, reasoningTokens: 3 });
  const openai = usageRecord({ input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
    output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } }, 'responses');
  assert.equal(openai.usage.uncachedInputTokens, 30);
  const summary = summarizeUsage([{ dispatched: true, ...anthropic }, { dispatched: true, ...openai }]);
  assert.equal(summary.knownTotalTokens, 189); assert.equal(summary.complete, true);
  assert.equal(summary.usage.cacheWriteInputTokens, 30);
  assert.deepEqual(summary.fieldCoverage.cacheWrite5mInputTokens, { reported: 1, attempts: 2 });
});

test('missing, invalid, and nullable counts cannot certify complete usage', () => {
  const partial = usageRecord({ input_tokens: 5, output_tokens: 2 }, 'messages');
  assert.equal(partial.usage.inputTokens, 5); assert.equal(partial.complete, false);
  assert.ok(partial.reasons.includes('input_breakdown_missing'));
  for (const value of [null, -1, Infinity, 1.5, '20', Number.MAX_SAFE_INTEGER + 1]) {
    const record = usageRecord({ input_tokens: value, output_tokens: 2 }, 'responses');
    assert.equal(record.complete, false); assert.equal(record.usage.inputTokens, undefined);
  }
  assert.equal(usageRecord({ input_tokens: 0, output_tokens: 0 }, 'responses').complete, true);
  assert.equal(usageRecord({ input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 6 } }, 'responses').complete, false);
  assert.equal(usageRecord({ input_tokens: 5, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } }, 'responses').complete, false);
  assert.equal(usageRecord(undefined, 'jev').complete, false);
});

test('attempt summaries distinguish zero dispatch, unknown usage, and partial known totals', () => {
  const none = summarizeUsage([{ dispatched: false, usage: {}, complete: true, reasons: [] }]);
  assert.equal(none.knownTotalTokens, 0); assert.equal(none.complete, true); assert.equal(none.attempts, 0);
  const unknown = summarizeUsage([{ dispatched: true, usage: {}, complete: false, reasons: ['cancelled'] }]);
  assert.equal(unknown.knownTotalTokens, undefined); assert.equal(unknown.complete, false);
  const partial = summarizeUsage([attempt(), { dispatched: true, ...usageRecord({ input_tokens: 4 }, 'responses') }]);
  assert.equal(partial.knownTotalTokens, 16); assert.equal(partial.complete, false);
  assert.equal(partial.attempts, 2); assert.equal(partial.completeAttempts, 1);
  assert.deepEqual(partial.fieldCoverage.outputTokens, { reported: 1, attempts: 2 });
});

test('Anthropic cumulative streaming usage becomes complete only with final usage and stop', () => {
  const observer = new UsageObserver(true, 'messages');
  observer.write(Buffer.from(sse({ type: 'message_start', message: { usage: {
    input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 1 } } })));
  assert.equal(observer.accounting().complete, false);
  observer.write(Buffer.from(sse({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } })));
  observer.write(Buffer.from(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 12, output_tokens: 9 } })));
  assert.equal(observer.accounting().complete, false);
  observer.write(Buffer.from(sse({ type: 'message_stop' }))); observer.finish();
  assert.equal(observer.outcome, 'incomplete'); assert.equal(observer.accounting().complete, true);
  assert.equal(observer.usage.inputTokens, 62); assert.equal(observer.usage.outputTokens, 9);
  assert.equal(observer.usage.cacheWriteInputTokens, 20);
  const early = new UsageObserver(true, 'messages');
  early.write(Buffer.from(sse({ type: 'message_start', message: { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + sse({ type: 'message_stop' })));
  early.finish(); assert.equal(early.accounting().complete, false);
});

test('terminal events without usage, truncated streams and observer limits stay partial', () => {
  const observer = new UsageObserver(true);
  observer.write(Buffer.from(sse({ type: 'response.in_progress', response: { usage: { input_tokens: 10, output_tokens: 1 } } }) +
    sse({ type: 'response.failed', response: { usage: null } })));
  observer.finish(); assert.equal(observer.usage.inputTokens, 10); assert.equal(observer.accounting().complete, false);
  const terminal = { type: 'response.incomplete', response: { usage: { input_tokens: 10, output_tokens: 2 } } };
  const incomplete = new UsageObserver(true); incomplete.write(Buffer.from(sse(terminal).trimEnd())); incomplete.finish();
  assert.equal(incomplete.accounting().complete, false); assert.equal(incomplete.usage.outputTokens, 2);
  const complete = new UsageObserver(true); complete.write(Buffer.from(sse(terminal))); complete.finish();
  assert.equal(complete.accounting().complete, true);
  const large = new UsageObserver(true); large.write(Buffer.from(sse({ text: 'x'.repeat(2_000_001) }) + sse(terminal))); large.finish();
  assert.equal(large.accounting().complete, false); assert.ok(large.accounting().reasons.includes('body_limit'));
});

test('authoritative final usage replaces stale optional breakdowns from intermediate events', () => {
  const observer = new UsageObserver(true);
  observer.write(Buffer.from(sse({ type: 'response.in_progress', response: { usage: { input_tokens: 100, output_tokens: 5,
    input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } } } }) +
    sse({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } })));
  observer.finish(); assert.equal(observer.accounting().complete, true);
  assert.deepEqual(observer.usage, { inputTokens: 10, outputTokens: 2 });
});

test('discarded-body limits and cancellation cannot wait for cancellation cleanup', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const result = await observeDiscardedUsage(new Response(stream));
  assert.ok(result.reasons.includes('body_timeout')); assert.equal(cancelled, true);
  const large = await observeDiscardedUsage(new Response('x'.repeat(64 * 1024 + 1)));
  assert.ok(large.reasons.includes('body_limit'));
  const aborted = await observeDiscardedUsage(Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }), AbortSignal.abort());
  assert.ok(aborted.reasons.includes('cancelled')); assert.equal(aborted.complete, false);
  assert.deepEqual(aborted.usage, {});
  const locked = new Response('body'); const reader = locked.body.getReader();
  assert.ok((await observeDiscardedUsage(locked)).reasons.includes('transport_error')); await reader.cancel(); reader.releaseLock();
});

test('task aggregation joins all calls, keeps failures and marks mixed modes separately', () => {
  const metrics = new Metrics();
  assert.equal(metrics.startTask({ id: 'task', cohort: 'baseline' }), true);
  const release = metrics.beginRequest('task');
  metrics.add(event('task', { inputTokens: 999, outputTokens: 999, modelAttempts: [attempt(3, 1), attempt(10, 2)],
    jevCalled: true, jevAttempt: attempt(5, 2) }));
  metrics.addTask(end('task', 'baseline', 1));
  let task = metrics.snapshot().taskUsage[0];
  assert.equal(task.complete, false); assert.ok(task.reasons.includes('requests_active'));
  release(); task = metrics.snapshot().taskUsage[0];
  assert.equal(task.complete, true); assert.equal(task.exitCode, 1);
  assert.equal(task.model.knownTotalTokens, 16); assert.equal(task.evaluator.knownTotalTokens, 7); assert.equal(task.combined.knownTotalTokens, 23);
  metrics.addTask(end('task', 'baseline', 1)); assert.equal(metrics.snapshot().tasks.length, 1);
  assert.equal(metrics.startTask({ id: 'task', cohort: 'baseline' }), false);
  metrics.add(event('task', { cohort: 'tool-only', kind: 'compaction' }));
  assert.equal(metrics.snapshot().taskUsage[0].cohort, 'mixed');
  assert.equal(metrics.observations().retainedRequests, 1);
});

test('unregistered, unfinished and late-request tasks cannot appear complete', () => {
  const metrics = new Metrics();
  metrics.add(event('orphan')); metrics.addTask(end('orphan'));
  assert.ok(metrics.snapshot().taskUsage[0].reasons.includes('task_start_missing'));
  assert.equal(metrics.startTask({ id: 'orphan', cohort: 'baseline' }), false);
  metrics.startTask({ id: 'live', cohort: 'baseline' }); metrics.add(event('live'));
  assert.ok(metrics.snapshot().taskUsage.find(t => t.id === 'live').reasons.includes('task_end_missing'));
  metrics.addTask(end('live')); const release = metrics.beginRequest('live'); release();
  assert.ok(metrics.snapshot().taskUsage.find(t => t.id === 'live').reasons.includes('request_after_task_end'));
  metrics.add(event(undefined)); assert.equal(metrics.snapshot().unassignedRequests, 1);
  const fresh = new Metrics(); fresh.addTask(end('orphan'));
  assert.equal(fresh.snapshot().taskUsage[0].complete, false);
});

test('request and lifecycle eviction cannot manufacture complete task coverage', () => {
  const metrics = new Metrics(); metrics.startTask({ id: 'long', cohort: 'baseline' });
  for (let i = 0; i < 2001; i++) metrics.add(event('long', { id: String(i) }));
  metrics.addTask(end('long'));
  let snapshot = metrics.snapshot(); const task = snapshot.taskUsage.find(t => t.id === 'long');
  assert.equal(snapshot.requests.length, 2000); assert.equal(snapshot.droppedRequests, 1);
  assert.equal(task.model.knownTotalTokens, 24_000); assert.equal(task.complete, false);
  assert.ok(task.reasons.includes('history_evicted'));
  metrics.startTask({ id: 'fresh', cohort: 'baseline' }); metrics.add(event('fresh')); metrics.addTask(end('fresh'));
  assert.equal(metrics.snapshot().taskUsage.find(t => t.id === 'fresh').complete, true);
  for (let i = 0; i < 201; i++) metrics.startTask({ id: `new-${i}`, cohort: 'baseline' });
  metrics.addTask(end('fresh')); snapshot = metrics.snapshot();
  assert.equal(snapshot.taskUsage.find(t => t.id === 'fresh').complete, false);
  assert.ok(snapshot.taskUsage.find(t => t.id === 'fresh').reasons.includes('task_start_missing'));
});

test('unobserved or entirely evicted usage stays unknown, while a proven empty task is zero', () => {
  const metrics = new Metrics(); metrics.startTask({ id: 'task', cohort: 'baseline' });
  const release = metrics.beginRequest('task');
  assert.equal(metrics.snapshot().taskUsage[0].model.knownTotalTokens, undefined);
  metrics.add(event('task')); release(); metrics.addTask(end('task'));
  for (let i = 0; i < 2000; i++) metrics.add(event(undefined));
  const lost = metrics.snapshot().taskUsage.find(t => t.id === 'task');
  assert.equal(lost.model.knownTotalTokens, undefined); assert.equal(lost.combined.knownTotalTokens, undefined);
  assert.equal(lost.complete, false); assert.ok(lost.reasons.includes('history_evicted'));
  metrics.startTask({ id: 'empty', cohort: 'baseline' }); metrics.addTask(end('empty'));
  const empty = metrics.snapshot().taskUsage.find(t => t.id === 'empty');
  assert.equal(empty.complete, true); assert.equal(empty.combined.knownTotalTokens, 0);
});
