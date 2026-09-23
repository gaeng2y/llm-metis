import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';
import { object } from './decision.js';
import { cohort } from './metrics.js';

interface Instance { id: string; token: string; port: number; pid: number }
const stateDir = () => resolve(process.env.JEV_STATE_DIR ?? join(homedir(), '.local', 'state', 'jev-control'));
const stateFile = () => join(stateDir(), 'instance.json');
const origin = (i: Instance) => `http://127.0.0.1:${i.port}`;
async function readInstance(): Promise<Instance | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(stateFile(), 'utf8'));
    if (object(v) && typeof v.id === 'string' && typeof v.token === 'string' && /^[a-f0-9]{64}$/.test(v.token) && Number.isInteger(v.port) && Number(v.port) > 0 && Number(v.port) <= 65535 && Number.isInteger(v.pid)) return v as unknown as Instance;
  } catch { /* Missing/stale state is handled by the requested command. */ }
}
async function api(i: Instance, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin(i)}/control/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-jev-token': i.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!res.ok) throw Error('Gateway management request failed');
  return await res.json() as Record<string, unknown>;
}
async function running() {
  const instance = await readInstance();
  if (instance) try {
    const status = await api(instance, 'status');
    if (status.service === 'jev-control' && status.pid === instance.pid) return { instance, status };
  } catch { /* Never signal a PID from a stale file. */ }
}
export async function detectUpstream(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.UPSTREAM_BASE_URL) return env.UPSTREAM_BASE_URL;
  try {
    const auth = JSON.parse(await readFile(join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), 'utf8'));
    if (auth.auth_mode === 'chatgpt' || (auth.tokens && !auth.OPENAI_API_KEY)) return 'https://chatgpt.com/backend-api/codex';
  } catch { /* Keyring-only logins need an explicit UPSTREAM_BASE_URL. */ }
  return 'https://api.openai.com/v1';
}
export function codexArgs(url: string): string[] {
  const settings = {
    model_provider: '"jev-control"',
    'model_providers.jev-control.name': '"jev-control"',
    'model_providers.jev-control.base_url': JSON.stringify(`${url}/v1`),
    'model_providers.jev-control.wire_api': '"responses"',
    'model_providers.jev-control.requires_openai_auth': 'true',
    'model_providers.jev-control.supports_websockets': 'false',
    'model_providers.jev-control.env_http_headers': '{ "x-jev-token" = "JEV_CONTROL_TOKEN", "x-jev-task-id" = "JEV_CONTROL_TASK_ID" }',
  };
  return Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}
async function serve() {
  const config = loadConfig({ ...process.env, UPSTREAM_BASE_URL: await detectUpstream() });
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const instance: Instance = { id: randomUUID(), token: randomBytes(32).toString('hex'), port: config.port, pid: process.pid };
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    const forced = setTimeout(() => server.closeAllConnections(), 5000); forced.unref();
    server.close(() => { void (async () => {
      clearTimeout(forced);
      if ((await readInstance())?.id === instance.id) await unlink(stateFile()).catch(() => {});
    })().finally(() => { process.exitCode = 0; }); });
  };
  const { server } = createGateway({ config, token: instance.token, onStop: stop });
  server.listen(config.port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const tmp = `${stateFile()}.${instance.id}`;
    await writeFile(tmp, JSON.stringify(instance), { mode: 0o600, flag: 'wx' });
    await rename(tmp, stateFile());
  } catch { server.close(); throw Error('Cannot write private gateway state'); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  if (process.send) { process.send({ ready: true }); process.disconnect(); }
}
async function ensureStarted() {
  const existing = await running(); if (existing) return existing;
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const lock = join(stateDir(), 'start.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw Error(`Another start is in progress. If no start process remains, remove ${lock} and retry.`); }
  try {
    const again = await running(); if (again) return again;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/jev-codex.mjs', import.meta.url)), '--serve'], { detached: true, stdio: ['ignore','ignore','ignore','ipc'], env: process.env });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Gateway startup timed out')); }, 8000);
      const cleanup = () => { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); child.removeAllListeners('message'); };
      child.once('error', () => { cleanup(); reject(Error('Cannot launch gateway')); });
      child.once('exit', () => { cleanup(); reject(Error('Gateway startup failed; run jev-codex --serve for details')); });
      child.once('message', msg => { cleanup(); if (object(msg) && msg.ready === true) accept(); else reject(Error('Gateway startup failed; run jev-codex --serve for details')); });
    });
    child.unref();
    const started = await running();
    if (!started) throw Error('Gateway did not become ready');
    return started;
  } finally { await rmdir(lock); }
}
const help = `jev-codex [-- <codex arguments>]
  --start                 Start local background gateway
  --stop                  Gracefully stop this gateway
  --status                Show status without starting
  --routing on|off        Enable/disable both decisions
  --tool-routing on|off   Toggle tool decisions
  --effort-routing on|off Toggle effort decisions
  --dashboard             Open private local dashboard
  --serve                 Run in foreground (diagnostics)

Uses current Codex authentication and per-process configuration overrides.
Set JEV_PROVIDER and its API key in the environment or local .env.
JEV_STATE_DIR and JEV_PORT select an independent local instance.
No arguments launches Codex; the gateway remains running until --stop.`;

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  if (args[0] === '--serve') { await serve(); return; }
  if (args[0] === '--status') {
    const live = await running();
    console.log(live ? JSON.stringify(live.status, null, 2) : 'jev-control is stopped'); return;
  }
  if (args[0] === '--stop') {
    const live = await running();
    if (!live) { console.log('jev-control is stopped'); return; }
    await api(live.instance, 'stop', {});
    for (let n = 0; n < 70; n++) {
      if (!(await running())) { console.log('jev-control stopped'); return; }
      await delay(100);
    }
    throw Error('Gateway is still stopping');
  }
  const command = args[0];
  const management = ['--routing','--tool-routing','--effort-routing'];
  if (command && management.includes(command) && (args.length !== 2 || !['on','off'].includes(args[1]!))) throw Error(`${command} requires on or off`);
  if (command?.startsWith('--') && command !== '--' && !['--start','--dashboard',...management].includes(command)) throw Error('Pass Codex arguments after --; use --help for gateway commands');
  const { instance, status } = await ensureStarted();
  if (command === '--start') { console.log(`jev-control running at ${origin(instance)}`); return; }
  if (command && management.includes(command)) {
    const enabled = args[1] === 'on';
    const patch = command === '--routing' ? { toolRouting: enabled, effortRouting: enabled } : command === '--tool-routing' ? { toolRouting: enabled } : { effortRouting: enabled };
    console.log(JSON.stringify(await api(instance, 'routing', patch))); return;
  }
  if (command === '--dashboard') {
    const url = `${origin(instance)}/dashboard#token=${instance.token}`;
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [url], { stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw Error('Could not open the local dashboard');
    console.log(`Dashboard opened at ${origin(instance)}/dashboard`); return;
  }
  const taskId = randomUUID();
  const started = performance.now();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, JEV_CONTROL_TOKEN: instance.token, JEV_CONTROL_TASK_ID: taskId };
  for (const key of ['TYPESAFE_API_KEY','OPENROUTER_API_KEY','AI_GATEWAY_API_KEY']) delete childEnv[key];
  const userArgs = command === '--' ? args.slice(1) : args;
  // Codex exec has its own -c parser; root-only overrides can disappear when exec also has -c.
  // Insert before a positional '--', otherwise append within the active command's options.
  const delimiter = userArgs.indexOf('--');
  const at = delimiter < 0 ? userArgs.length : delimiter;
  const child = spawn(process.env.JEV_CODEX_BIN ?? 'codex', [...userArgs.slice(0, at), ...codexArgs(origin(instance)), ...userArgs.slice(at)], { stdio: 'inherit', env: childEnv });
  // Terminal signals also reach Codex in the foreground group. Let Codex handle Ctrl-C itself.
  const interrupt = () => {}; const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await once(child, 'exit');
    await api(instance, 'task', { id: taskId, cohort: cohort({ toolRouting: Boolean(status.toolRouting), effortRouting: Boolean(status.effortRouting) }), durationMs: performance.now() - started, exitCode: code }).catch(() => {});
    process.exitCode = typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
