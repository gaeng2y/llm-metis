import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluatorKeys = ['OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY'];
const bins = Object.fromEntries(['codex', 'claude'].map(client => [client, fileURLToPath(new URL(`../bin/metis-${client}.mjs`, import.meta.url))]));
function run(client, args, env, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bins[client], ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Client fixture timed out')); }, 15000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function success(result) { assert.equal(result.code, 0, result.stderr); return result; }

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "metis clients 한글 ' & ")));
  const project = join(dir, 'another project');
  await mkdir(project);
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'fixture reply' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const fake = join(dir, 'fake-client.mjs');
  await writeFile(fake, `import {readFile,writeFile,stat} from 'node:fs/promises';
const args=process.argv.slice(2);
const at=args.indexOf('--settings');
const settingsFile=at<0?undefined:args[at+1];
const settings=settingsFile?JSON.parse(await readFile(settingsFile,'utf8')):undefined;
const effective={...process.env,...settings?.env};
const capture={args,cwd:process.cwd(),settingsFile,settings,mode:settingsFile?(await stat(settingsFile)).mode&0o777:undefined,
  controlEnv:!!process.env.METIS_CONTROL_TOKEN||!!process.env.METIS_CONTROL_TASK_ID,
  auth:Object.fromEntries(['OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'].map(key=>[key,process.env[key]])),
  evaluatorKeys:Object.keys(process.env).filter(key=>${JSON.stringify(evaluatorKeys)}.includes(key.toUpperCase()))};
let input='';for await(const chunk of process.stdin)input+=chunk;
if(settings){
  const headers=Object.fromEntries(effective.ANTHROPIC_CUSTOM_HEADERS.split(/\\r?\\n/).map(line=>{const colon=line.indexOf(':');return[line.slice(0,colon).trim(),line.slice(colon+1).trim()];}));
  Object.assign(headers,{'content-type':'application/json','anthropic-version':'2023-06-01',authorization:'Bearer '+effective.ANTHROPIC_AUTH_TOKEN,'x-api-key':effective.ANTHROPIC_API_KEY});
  const response=await fetch(effective.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model:'claude-fixture',max_tokens:32,messages:[{role:'user',content:input}]}),signal:AbortSignal.timeout(5000)});
  capture.response={status:response.status,body:await response.json()};
}
await writeFile(process.env.METIS_TEST_CAPTURE,JSON.stringify(capture));
process.stdout.write('client:'+input);process.stderr.write('fixture-stderr');
process.exitCode=Number(process.env.METIS_TEST_EXIT??0);
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith('METIS_') && !key.startsWith('JEV_') && !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_') && !evaluatorKeys.includes(key) && !['HOME', 'USERPROFILE', 'CODEX_HOME', 'UPSTREAM_BASE_URL', 'OPENAI_API_KEY'].includes(key);
  }));
  Object.assign(env, { HOME: dir, USERPROFILE: dir, CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir,
    METIS_CONFIG: join(dir, 'metis.json'), METIS_STATE_DIR: join(dir, 'state'), METIS_PORT: String(port), METIS_ROUTING: 'off',
    METIS_CODEX_BIN: fake, METIS_CLAUDE_BIN: fake, METIS_TEST_CAPTURE: join(dir, 'capture.json'),
    METIS_URL: `http://127.0.0.1:${upstream.address().port}/evaluate`, UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, METIS_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENAI_API_KEY: 'fake-openai-key', ANTHROPIC_API_KEY: 'fake-anthropic-key', ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-token', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Organization: original\nx-Metis-Token: stale\nX-JEV-Task-Id: stale',
  });
  for (const key of evaluatorKeys) env[process.platform === 'win32' ? key.toLowerCase() : key] = 'fake-evaluator-key';
  const cli = (client, args = [], input = '', extraEnv = {}) => run(client, args, { ...env, ...extraEnv }, project, input);
  t.after(async () => {
    await cli('codex', ['--stop']).catch(() => {});
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, project, env, port, requests, cli, capture: async () => JSON.parse(await readFile(env.METIS_TEST_CAPTURE, 'utf8')) };
}

test('bare client commands launch interactive clients with inherited cwd, streams, auth, and private gateway routing', async t => {
  const f = await fixture(t);
  for (const client of ['codex', 'claude']) {
    const result = success(await f.cli(client, [], 'input from terminal\n'));
    assert.equal(result.stdout, 'client:input from terminal\n');
    assert.equal(result.stderr, 'fixture-stderr');
    const capture = await f.capture();
    assert.equal(capture.cwd, f.project);
    assert.ok(!capture.args.includes('exec') && !capture.args.includes('--print') && !capture.args.includes('-p'));
    assert.deepEqual(capture.evaluatorKeys, []);
    assert.equal(capture.controlEnv, client === 'codex');
    assert.deepEqual(capture.auth, { OPENAI_API_KEY: 'fake-openai-key', ANTHROPIC_API_KEY: 'fake-anthropic-key', ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-token', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' });
    if (client === 'codex') assert.ok(capture.args.includes('model_provider="metis"'));
    else {
      assert.deepEqual(capture.args, ['--settings', capture.settingsFile]);
      if (process.platform !== 'win32') assert.equal(capture.mode, 0o600);
      const instance = JSON.parse(await readFile(join(f.env.METIS_STATE_DIR, 'instance.json'), 'utf8'));
      const gatewayUrl = new URL(capture.settings.env.ANTHROPIC_BASE_URL);
      assert.equal(gatewayUrl.origin, `http://127.0.0.1:${f.port}`);
      assert.equal(gatewayUrl.pathname.split('/')[1], 'anthropic');
      assert.equal(gatewayUrl.pathname.split('/')[2], instance.token);
      assert.match(gatewayUrl.pathname.split('/')[3], /^[\w-]{1,80}$/);
      assert.ok(!Object.hasOwn(capture.settings.env, 'ANTHROPIC_CUSTOM_HEADERS'));
      assert.ok(!capture.args.join(' ').includes(instance.token));
      assert.equal(capture.response.status, 200);
      assert.equal(capture.response.body.id, 'msg_fixture');
      await assert.rejects(stat(capture.settingsFile), { code: 'ENOENT' });
    }
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/messages');
  assert.equal(f.requests[0].headers.authorization, 'Bearer fake-anthropic-token');
  assert.equal(f.requests[0].headers['x-api-key'], 'fake-anthropic-key');
  assert.equal(f.requests[0].headers['x-organization'], 'original');
  assert.ok(!Object.keys(f.requests[0].headers).some(key => key.startsWith('x-metis-') || key.startsWith('x-jev-')));
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/anthropic/v1/messages`, { method: 'POST', body: '{}' })).status, 401);
});

test('Claude preserves explicit settings and user arguments, cleans private settings on client and launch failures', async t => {
  const f = await fixture(t);
  const original = JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM_FLAG: 'keep-me', ANTHROPIC_AUTH_TOKEN: 'settings-auth-token', ANTHROPIC_BASE_URL: 'https://unused.example', ANTHROPIC_CUSTOM_HEADERS: 'X-Organization: settings\nX-Metis-Token: stale' } });
  const settings = join(f.project, 'user settings.json');
  await writeFile(settings, original);
  const prompt = 'quoted "prompt" & | %PATH% $(untouched)';
  for (const option of [['--settings', settings], [`--settings=${original}`]]) {
    const result = await f.cli('claude', ['--model', 'claude-fixture', ...option, '--', prompt], 'configured input', { METIS_TEST_EXIT: '7' });
    assert.equal(result.code, 7, result.stderr);
    const capture = await f.capture();
    assert.deepEqual(capture.args, ['--model', 'claude-fixture', '--settings', capture.settingsFile, '--', prompt]);
    assert.deepEqual(capture.settings.permissions, { allow: ['Read'] });
    assert.equal(capture.settings.env.CUSTOM_FLAG, 'keep-me');
    assert.equal(capture.settings.env.ANTHROPIC_AUTH_TOKEN, 'settings-auth-token');
    assert.equal(capture.settings.env.ANTHROPIC_CUSTOM_HEADERS, JSON.parse(original).env.ANTHROPIC_CUSTOM_HEADERS);
    assert.equal(capture.response.status, 200);
    assert.equal(f.requests.at(-1).headers.authorization, 'Bearer settings-auth-token');
    assert.equal(f.requests.at(-1).headers['x-organization'], 'settings');
    await assert.rejects(stat(capture.settingsFile), { code: 'ENOENT' });
  }
  assert.equal(await readFile(settings, 'utf8'), original);
  const failure = await f.cli('claude', [], '', { METIS_CLAUDE_BIN: join(f.dir, 'missing-client.exe') });
  assert.notEqual(failure.code, 0);
  assert.deepEqual((await readdir(f.env.METIS_STATE_DIR)).filter(file => file.startsWith('claude-')), []);
});

test('Claude refuses cloud backend flags from the environment and regular settings files', async t => {
  const f = await fixture(t);
  for (const value of ['1', 'true', 'on', 'yes']) {
    const result = await f.cli('claude', [], '', { CLAUDE_CODE_USE_BEDROCK: value });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Anthropic Messages API/);
  }
  const projectSettings = join(f.project, '.claude');
  await mkdir(projectSettings);
  for (const [file, key, value] of [
    [join(f.dir, 'settings.json'), 'CLAUDE_CODE_USE_VERTEX', 'on'],
    [join(projectSettings, 'settings.json'), 'CLAUDE_CODE_USE_FOUNDRY', 'yes'],
    [join(projectSettings, 'settings.local.json'), 'CLAUDE_CODE_USE_BEDROCK', 'true'],
  ]) {
    const original = JSON.stringify({ env: { [key]: value } });
    await writeFile(file, original);
    const result = await f.cli('claude');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Anthropic Messages API/);
    assert.equal(await readFile(file, 'utf8'), original);
    await rm(file);
  }
  await assert.rejects(stat(f.env.METIS_TEST_CAPTURE), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.env.METIS_STATE_DIR)).filter(file => file.startsWith('claude-')), []);
});

test('Claude refuses a running gateway without Messages support before launching a client', async t => {
  const f = await fixture(t);
  const token = 'c'.repeat(64);
  const legacy = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/control/status' && req.headers['x-metis-token'] === token) res.end(JSON.stringify({ service: 'llm-metis', pid: process.pid }));
    else { res.writeHead(404); res.end('{}'); }
  });
  legacy.listen(0, '127.0.0.1');
  await once(legacy, 'listening');
  t.after(async () => { legacy.closeAllConnections(); await new Promise(resolve => legacy.close(resolve)); });
  await mkdir(f.env.METIS_STATE_DIR);
  await writeFile(join(f.env.METIS_STATE_DIR, 'instance.json'), JSON.stringify({ id: 'old-metis', token, port: legacy.address().port, pid: process.pid }));
  const result = await f.cli('claude');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /gateway needs an update/);
  await assert.rejects(stat(f.env.METIS_TEST_CAPTURE), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.env.METIS_STATE_DIR)).filter(file => file.startsWith('claude-')), []);
});
