import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/metis-codex.mjs', import.meta.url));
const keys = { openrouter: 'OPENROUTER_API_KEY', vercel: 'AI_GATEWAY_API_KEY', typesafe: 'TYPESAFE_API_KEY' };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'metis configure '));
  const elsewhere = join(dir, 'another project');
  await mkdir(elsewhere);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith('METIS_') && !key.startsWith('JEV_') && !Object.values(keys).includes(key) && key !== 'UPSTREAM_BASE_URL';
  }));
  Object.assign(env, { METIS_CONFIG: join(dir, 'user settings', 'config.json'), METIS_STATE_DIR: join(dir, 'state'), CODEX_HOME: dir });
  const cli = (args, { input = '', extraEnv = {}, cwd = dir } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('CLI fixture timed out')); }, 15000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  t.after(async () => {
    await cli(['--stop']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const readConfig = async () => JSON.parse(await readFile(env.METIS_CONFIG, 'utf8'));
  return { dir, elsewhere, env, cli, readConfig };
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
  return result;
}

test('configure persists all provider keys privately, supports aliases, and never edits project .env', async t => {
  const f = await fixture(t);
  const dotenv = '# Existing project settings stay unchanged.\nUNRELATED_SETTING=present\n';
  await writeFile(join(f.dir, '.env'), dotenv);
  assert.equal(success(await f.cli(['config-path'])).stdout.trim(), f.env.METIS_CONFIG);
  const saved = {};
  for (const [index, provider] of Object.keys(keys).entries()) {
    const secret = `fake-${provider}-private-key`;
    const command = index === 1 ? 'configuration' : 'configure';
    const result = success(await f.cli([command, '--provider', provider, '--key-stdin'], { input: `  ${secret}  \n` }));
    saved[provider] = secret;
    assert.deepEqual(await f.readConfig(), { provider, keys: saved });
    for (const key of Object.values(saved)) assert.ok(!(result.stdout + result.stderr).includes(key));
  }
  success(await f.cli(['configure', '--provider', 'openrouter', '--key-stdin'], { input: 'replacement-openrouter-key\n', cwd: f.elsewhere }));
  saved.openrouter = 'replacement-openrouter-key';
  assert.deepEqual(await f.readConfig(), { provider: 'openrouter', keys: saved });
  const switched = success(await f.cli(['configure', '--provider', 'vercel']));
  assert.deepEqual(await f.readConfig(), { provider: 'vercel', keys: saved });
  for (const key of Object.values(saved)) assert.ok(!(switched.stdout + switched.stderr).includes(key));
  assert.equal(await readFile(join(f.dir, '.env'), 'utf8'), dotenv);
  await assert.rejects(stat(join(f.elsewhere, '.env')), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await stat(f.env.METIS_CONFIG)).mode & 0o777, 0o600);
});

test('saved configuration works across directories, takes effect after restart, and yields to nonblank environment', async t => {
  const f = await fixture(t);
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/evaluate') {
      calls.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      res.end(JSON.stringify({ answers: { tool: { type: 'choice', choice: 'passthrough', confidence: 1 }, effort: { type: 'choice', choice: 'low', confidence: 1 } } }));
    } else {
      assert.equal(req.headers.authorization, 'Bearer fake-model-key');
      res.end(JSON.stringify({ id: 'fixture-response', object: 'response', status: 'completed', output: [] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  Object.assign(f.env, { METIS_PORT: String(port), METIS_URL: `http://127.0.0.1:${server.address().port}/evaluate`, UPSTREAM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
  const status = async () => JSON.parse(success(await f.cli(['--status'], { cwd: f.elsewhere })).stdout);
  const request = async expectedKey => {
    const instance = JSON.parse(await readFile(join(f.env.METIS_STATE_DIR, 'instance.json'), 'utf8'));
    const before = calls.length;
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-metis-token': instance.token, authorization: 'Bearer fake-model-key' },
      body: JSON.stringify({ model: 'fixture-model', input: 'Reply briefly.', reasoning: { effort: 'high' } }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).authorization, `Bearer ${expectedKey}`);
  };
  for (const provider of ['openrouter', 'vercel']) {
    success(await f.cli(['configure', '--provider', provider, '--key-stdin'], { input: `saved-${provider}-key\n` }));
  }
  success(await f.cli(['--start'], { cwd: f.elsewhere }));
  const live = await status();
  assert.equal(live.provider, 'vercel');
  assert.equal(live.jevConfigured, true);
  await request('saved-vercel-key');
  assert.deepEqual(calls.at(-1).body.providerOptions, { gateway: { only: ['typesafe-ai'] } });

  const fakeCodex = join(f.dir, 'fake-codex.mjs');
  const capture = join(f.dir, 'codex-environment.json');
  const script = "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.METIS_TEST_CAPTURE, JSON.stringify(Object.keys(process.env).filter(key => " + JSON.stringify(Object.values(keys)) + ".includes(key.toUpperCase()))));\n";
  await writeFile(fakeCodex, script);
  success(await f.cli(['--', 'exec', 'Fixture only'], { cwd: f.elsewhere, extraEnv: { METIS_CODEX_BIN: fakeCodex, METIS_TEST_CAPTURE: capture } }));
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), []);

  const configured = success(await f.cli(['configuration', '--provider', 'typesafe', '--key-stdin'], { input: 'saved-typesafe-key\n' }));
  assert.match(configured.stdout + configured.stderr, /--stop/);
  assert.match(configured.stdout + configured.stderr, /--start/);
  assert.equal((await status()).pid, live.pid);
  assert.equal((await status()).provider, 'vercel');
  await request('saved-vercel-key');

  success(await f.cli(['--stop']));
  success(await f.cli(['--start'], { cwd: f.elsewhere, extraEnv: { METIS_PROVIDER: '  ', JEV_PROVIDER: 'vercel', TYPESAFE_API_KEY: '  ' } }));
  assert.equal((await status()).provider, 'typesafe');
  await request('saved-typesafe-key');
  assert.equal(calls.at(-1).body.model, 'jev-latest');

  success(await f.cli(['--stop']));
  success(await f.cli(['--start'], { cwd: f.elsewhere, extraEnv: { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'environment-openrouter-key' } }));
  const overridden = await status();
  assert.equal(overridden.provider, 'openrouter');
  await request('environment-openrouter-key');
  assert.deepEqual(calls.at(-1).body.provider, { only: ['typesafe'], allow_fallbacks: false });
  assert.ok(!JSON.stringify(overridden).includes('environment-openrouter-key'));
  assert.equal((await f.readConfig()).provider, 'typesafe');
});

test('invalid configure input and malformed stored settings preserve files without exposing credentials', async t => {
  const f = await fixture(t);
  success(await f.cli(['configure', '--provider', 'openrouter', '--key-stdin'], { input: 'saved-private-key\n' }));
  const original = await readFile(f.env.METIS_CONFIG, 'utf8');
  for (const [args, input] of [
    [['configure', '--provider', 'unknown', '--key-stdin'], 'never-display-this-key\n'],
    [['configure', '--provider', 'openrouter', '--key-stdin'], '  \n'],
  ]) {
    const result = await f.cli(args, { input });
    assert.notEqual(result.code, 0);
    assert.ok(!(result.stdout + result.stderr).includes('never-display-this-key'));
    assert.ok(!(result.stdout + result.stderr).includes('saved-private-key'));
    assert.equal(await readFile(f.env.METIS_CONFIG, 'utf8'), original);
  }
  const malformed = '{"provider":"openrouter","keys":{"openrouter":"malformed-private-key"},broken';
  await writeFile(f.env.METIS_CONFIG, malformed);
  const result = await f.cli(['configure', '--provider', 'vercel', '--key-stdin'], { input: 'replacement-private-key\n' });
  assert.notEqual(result.code, 0);
  assert.ok(!(result.stdout + result.stderr).includes('malformed-private-key'));
  assert.ok(!(result.stdout + result.stderr).includes('replacement-private-key'));
  assert.equal(await readFile(f.env.METIS_CONFIG, 'utf8'), malformed);
});
