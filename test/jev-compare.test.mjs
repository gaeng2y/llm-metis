import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cases, models, compare } from './jev-compare.mjs';
import { extractState } from '../dist/state.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./jev-compare.mjs', import.meta.url));
const choice = value => ({ type: 'choice', choice: value, probabilities: { [value]: .99 } });
function answer(body) {
  const example = cases.find(value => value.request.input === body.state.userTask);
  return { model: body.model, answers: { tool: choice(['no_tool', 'high'].includes(example.scenario) ? 'no_tool' : example.scenario === 'ambiguous' ? 'passthrough' : 't0'),
    effort: choice(example.scenario === 'high' ? 'high' : 'low'), ...(example.scenario === 'finite' ? { a0_0: choice('v1') } : {}) },
    usage: { input_tokens: 50, output_tokens: 0, input_tokens_details: { cached_tokens: 10 }, cost: .0000021 } };
}
async function fixture(t, handler = (body, res) => res.end(JSON.stringify(answer(body)))) {
  const dir = await mkdtemp(join(tmpdir(), 'metis jev comparison '));
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    handler(body, res, requests.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const env = { METIS_CONFIG: join(dir, 'settings.json'), METIS_URL: `http://127.0.0.1:${server.address().port}/evaluate`, OPENROUTER_API_KEY: 'fixture-private-key' };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, requests, env };
}

test('comparison uses 60 sequential pinned requests with alternating repeat order and fixed production controls', async t => {
  const f = await fixture(t, (body, res, count) => {
    const raw = answer(body);
    if (count === 60) { raw.model = 'fixture-private-key'; raw.answers['fixture-private-key'] = 'fixture-private-key'; }
    res.end(JSON.stringify(raw));
  });
  const snapshots = [];
  const report = await compare({ env: { ...f.env, OPENROUTER_API_KEY: ' fixture-private-key ', METIS_MODEL: 'wrong', METIS_TIMEOUT_MS: '99', METIS_TOOL_MIN_CONFIDENCE: '0', METIS_TOOL_ROUTING: 'off' }, save: async text => snapshots.push(JSON.parse(text)) });
  assert.equal(report.rows.length, 60); assert.equal(f.requests.length, 60);
  for (const [index, request] of f.requests.entries()) {
    const repeat = Math.floor(index / 20), example = cases[Math.floor(index % 20 / 2)];
    const expectedModel = (repeat % 2 ? [...models].reverse() : models)[index % 2];
    assert.equal(request.path, '/evaluate'); assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer fixture-private-key');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(Object.keys(request.body).sort(), ['model', 'provider', 'questions', 'state']);
    assert.equal(request.body.model, expectedModel);
    assert.deepEqual(request.body.provider, { only: ['typesafe'], allow_fallbacks: false });
    assert.deepEqual(request.body.state, JSON.parse(JSON.stringify(extractState(example.request))));
    assert.deepEqual(Object.keys(request.body.questions), example.scenario === 'finite' ? ['tool', 'effort', 'a0_0'] : ['tool', 'effort']);
    assert.deepEqual(Object.keys(request.body.questions.tool.criteria), example.scenario === 'finite' ? ['t0', 'no_tool', 'passthrough'] : ['t0', 't1', 't2', 'no_tool', 'passthrough']);
    assert.deepEqual(Object.keys(request.body.questions.effort.criteria), ['low', 'medium', 'high']);
    if (example.scenario === 'finite') assert.deepEqual(request.body.questions.a0_0.criteria, { v0: '"brief"', v1: '"full"', undecided: 'Insufficient evidence; main model must decide.' });
  }
  assert.ok(report.rows.every(row => row.quality.applied === 'pass'));
  assert.equal(report.rows[0].answerEvidence.tool.confidence, null);
  assert.equal(report.rows[0].answerEvidence.tool.selectedProbability, .99);
  assert.equal(report.rows[0].decision.tool.confidence, .99);
  assert.equal(report.rows[0].returnedModel, models[0]);
  assert.equal(report.summary[0].knownInputTokens, 1500);
  assert.equal(report.summary[0].knownCachedInputTokens, 300);
  assert.equal(report.summary[0].usageCompleteCalls, 30);
  assert.equal(report.summary[0].reportedCostCalls, 30);
  assert.equal(snapshots.length, 62);
  assert.equal(snapshots[1].rows.length, 1);
  assert.equal(report.rows.at(-1).returnedModel, '[REDACTED]');
  assert.equal(report.rows.at(-1).rawAnswers['[REDACTED]'], '[REDACTED]');
  assert.ok(snapshots.every(snapshot => !JSON.stringify(snapshot).includes('fixture-private-key')));
});

test('authentication stops after one request, retains only production usage, and does not score failure as a safe defer', async t => {
  const f = await fixture(t, (_body, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ model: 'fixture-private-key', answers: { 'fixture-private-key': 'fixture-private-key' }, usage: { input_tokens: 3 } }));
  });
  const snapshots = [];
  const report = await compare({ env: { ...f.env, OPENROUTER_API_KEY: ' fixture-private-key ' }, save: async text => snapshots.push(text) });
  assert.equal(f.requests.length, 1); assert.equal(report.stopped, 'authentication');
  assert.equal(report.rows[0].quality.applied, 'unscored');
  assert.equal(report.rows[0].route.failure, 'authentication');
  assert.equal(report.rows[0].returnedModel, null);
  assert.equal(report.rows[0].rawAnswers, null);
  assert.equal(report.rows[0].rawUsage, null);
  assert.equal(report.rows[0].rawError, null);
  assert.equal(report.rows[0].usage.usage.inputTokens, 3);
  assert.ok(snapshots.every(text => !text.includes('fixture-private-key')));
  assert.equal(report.summary[0].cacheReportedCalls, 0);
  assert.equal(report.summary[0].knownCachedInputTokens, null);
  assert.equal(report.summary[0].knownReportedCost, null);
});

test('delayed authentication body preserves the production 100ms body deadline and stops immediately', async t => {
  const f = await fixture(t, (_body, res, count) => {
    res.statusCode = 401;
    if (count === 1) res.write('{"usage":'); else res.end('{}');
  });
  const report = await compare({ env: f.env, repeats: 1 });
  assert.equal(f.requests.length, 1);
  assert.equal(report.stopped, 'authentication');
  assert.equal(report.rows[0].route.failure, 'authentication');
  assert.ok(report.rows[0].usage.reasons.includes('body_timeout'));
  assert.ok(report.rows[0].latencyMs >= 75 && report.rows[0].latencyMs < 1000);
});

test('failures are unscored unless an unsafe partial rewrite applies; confidence and effort gates remain fixed', async t => {
  const f = await fixture(t, (body, res, count) => {
    if (count === 1) return;
    if (count === 2) { res.end('invalid JSON'); return; }
    const raw = answer(body);
    if (count === 3) raw.answers.tool = { type: 'choice', choice: 't0', confidence: .84, probabilities: { t0: .99 } };
    if (count === 5 || count === 6) raw.answers.effort = { type: 'choice', choice: 'low', confidence: .99 };
    if (count === 6) raw.answers.tool = { type: 'choice', choice: 'invented', confidence: .99 };
    delete raw.model;
    delete raw.usage;
    res.end(JSON.stringify(raw));
  });
  const report = await compare({ env: f.env, repeats: 1 });
  assert.equal(report.rows[0].route.failure, 'timeout');
  assert.equal(report.rows[0].quality.applied, 'unscored');
  assert.ok(report.rows[0].latencyMs >= 1900 && report.rows[0].latencyMs < 5000);
  assert.equal(report.rows[1].route.failure, 'invalid_response');
  assert.equal(report.rows[1].quality.applied, 'unscored');
  assert.equal(report.rows[2].quality.applied, 'abstained');
  assert.equal(report.rows[2].answerEvidence.tool.confidence, .84);
  assert.equal(report.rows[2].answerEvidence.tool.selectedProbability, .99);
  assert.equal(report.rows[2].returnedModel, null);
  assert.equal(report.rows[2].usage.complete, false);
  assert.equal(report.rows[4].quality.applied, 'unsafe');
  assert.equal(report.rows[5].route.outcome, 'failed');
  assert.equal(report.rows[5].route.failure, 'invalid_response');
  assert.equal(report.rows[5].route.effortApplied, true);
  assert.equal(report.rows[5].route.resultingEffort, 'low');
  assert.deepEqual(report.rows[5].quality, { applied: 'unsafe', rawToolCorrect: null, rawEffortCorrect: null });
  assert.equal(report.summary[0].knownInputTokens, null);
});

test('CLI requires live opt-in, loads local env with process precedence, and refuses overwriting results', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'settings.json'), JSON.stringify({ provider: 'typesafe', keys: { openrouter: 'saved-key' } }));
  await writeFile(join(f.dir, '.env'), 'OPENROUTER_API_KEY=dotenv-key\n');
  const env = { PATH: process.env.PATH, ...f.env, OPENROUTER_API_KEY: 'process-key' };
  if (process.platform === 'win32') Object.assign(env, { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP });
  await assert.rejects(exec(process.execPath, [script, '--output', join(f.dir, 'not-created.json')], { cwd: f.dir, env }));
  assert.equal(f.requests.length, 0);
  const output = join(f.dir, 'results.json');
  const args = [script, '--live', '--repeats', '1', '--output', output];
  const result = await exec(process.execPath, args, { cwd: f.dir, env });
  assert.equal(f.requests.length, 20);
  assert.ok(f.requests.every(request => request.headers.authorization === 'Bearer process-key'));
  const text = await readFile(output, 'utf8');
  assert.equal(JSON.parse(text).rows.length, 20);
  assert.ok(!`${text}${result.stdout}${result.stderr}`.includes('process-key'));
  await assert.rejects(exec(process.execPath, args, { cwd: f.dir, env }));
  assert.equal(f.requests.length, 20);
  assert.equal(await readFile(output, 'utf8'), text);
});

test('comparison rejects excess repeats and non-OpenRouter remote URL before inference', async t => {
  const f = await fixture(t);
  await assert.rejects(compare({ env: f.env, repeats: 4 }));
  await assert.rejects(compare({ env: { ...f.env, METIS_URL: 'https://example.com/evaluate' }, repeats: 1 }));
  assert.equal(f.requests.length, 0);
});
