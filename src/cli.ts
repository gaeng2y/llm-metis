import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, normalizedEnv, PROVIDERS } from './config.js';
import { createGateway } from './gateway.js';
import { object } from './decision.js';
import { cohort } from './metrics.js';
import { codexLaunch, dashboardLaunch, writePrivateFile } from './platform.js';

interface Instance { id: string; token: string; port: number; pid: number; legacy?: boolean }
const stateDir = () => resolve(process.env.METIS_STATE_DIR ?? join(homedir(), '.local', 'state', 'llm-metis'));
const stateFile = () => join(stateDir(), 'instance.json');
const origin = (i: Instance) => `http://127.0.0.1:${i.port}`;
async function readInstance(file = stateFile()): Promise<Instance | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (object(v) && typeof v.id === 'string' && typeof v.token === 'string' && /^[a-f0-9]{64}$/.test(v.token) && Number.isInteger(v.port) && Number(v.port) > 0 && Number(v.port) <= 65535 && Number.isInteger(v.pid)) return v as unknown as Instance;
  } catch { /* Missing/stale state is handled by the requested command. */ }
}
async function api(i: Instance, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin(i)}/control/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { [i.legacy ? 'x-jev-token' : 'x-metis-token']: i.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!res.ok) throw Error('Gateway management request failed');
  return await res.json() as Record<string, unknown>;
}
async function running(currentOnly = false) {
  const files = [stateFile()];
  if (process.env.METIS_STATE_DIR === undefined) files.push(join(homedir(), '.local', 'state', 'jev-control', 'instance.json'));
  for (const file of files) {
    const saved = await readInstance(file);
    if (!saved || (file !== stateFile() && saved.port !== Number(process.env.METIS_PORT ?? 8791))) continue;
    for (const legacy of [false, true]) {
      const instance = { ...saved, legacy };
      let status: Record<string, unknown>;
      try { status = await api(instance, 'status'); }
      catch { continue; } // Never signal a PID from a stale file.
      if (status.service !== (legacy ? 'jev-control' : 'llm-metis') || status.pid !== instance.pid) continue;
      if (currentOnly && legacy) throw Error('An older gateway is running. After its tasks finish, run metis-codex --stop then metis-codex --start to use Metis.');
      return { instance, status };
    }
  }
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
    model_provider: '"metis"',
    'model_providers.metis.name': '"Metis"',
    'model_providers.metis.base_url': JSON.stringify(`${url}/v1`),
    'model_providers.metis.wire_api': '"responses"',
    'model_providers.metis.requires_openai_auth': 'true',
    'model_providers.metis.supports_websockets': 'false',
    'model_providers.metis.env_http_headers': '{ "x-metis-token" = "METIS_CONTROL_TOKEN", "x-metis-task-id" = "METIS_CONTROL_TASK_ID" }',
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
    await writePrivateFile(tmp, JSON.stringify(instance));
    await rename(tmp, stateFile());
  } catch { server.close(); throw Error('Cannot write private gateway state'); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  if (process.send) { process.send({ ready: true }); process.disconnect(); }
}
async function ensureStarted() {
  const existing = await running(true); if (existing) return existing;
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const lock = join(stateDir(), 'start.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw Error(`Another start is in progress. If no start process remains, remove ${lock} and retry.`); }
  try {
    const again = await running(true); if (again) return again;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/metis-codex.mjs', import.meta.url)), '--serve'], { detached: true, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], env: process.env });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Gateway startup timed out')); }, 8000);
      const cleanup = () => { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); child.removeAllListeners('message'); };
      child.once('error', () => { cleanup(); reject(Error('Cannot launch gateway')); });
      child.once('exit', () => { cleanup(); reject(Error('Gateway startup failed; run metis-codex --serve for details')); });
      child.once('message', msg => { cleanup(); if (object(msg) && msg.ready === true) accept(); else reject(Error('Gateway startup failed; run metis-codex --serve for details')); });
    });
    child.unref();
    const started = await running();
    if (!started) throw Error('Gateway did not become ready');
    return started;
  } finally { await rmdir(lock); }
}
const help = `metis-codex [-- <codex arguments>]
  --start                 Start local background gateway
  --stop                  Gracefully stop this gateway
  --status                Show status without starting
  --routing on|off        Enable/disable both decisions
  --tool-routing on|off   Toggle tool decisions
  --effort-routing on|off Toggle effort decisions
  --dashboard             Open private local dashboard
  --serve                 Run in foreground (diagnostics)

Uses current Codex authentication and per-process configuration overrides.
Set METIS_PROVIDER and its API key in the environment or local .env.
METIS_STATE_DIR and METIS_PORT select an independent local instance.
No arguments launches Codex; the gateway remains running until --stop.`;

export async function main(args = process.argv.slice(2)) {
  Object.assign(process.env, normalizedEnv());
  if (args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  if (args[0] === '--serve') { await serve(); return; }
  if (args[0] === '--status') {
    const live = await running();
    console.log(live ? JSON.stringify(live.status, null, 2) : 'llm-metis is stopped'); return;
  }
  if (args[0] === '--stop') {
    const live = await running();
    if (!live) { console.log('llm-metis is stopped'); return; }
    await api(live.instance, 'stop', {});
    for (let n = 0; n < 70; n++) {
      const status = await api(live.instance, 'status').catch(() => undefined);
      if (!status || status.pid !== live.instance.pid || status.service !== live.status.service) { console.log('llm-metis stopped'); return; }
      await delay(100);
    }
    throw Error('Gateway is still stopping');
  }
  const command = args[0];
  const management = ['--routing','--tool-routing','--effort-routing'];
  if (command && management.includes(command) && (args.length !== 2 || !['on','off'].includes(args[1]!))) throw Error(`${command} requires on or off`);
  if (command?.startsWith('--') && command !== '--' && !['--start','--dashboard',...management].includes(command)) throw Error('Pass Codex arguments after --; use --help for gateway commands');
  const { instance, status } = await ensureStarted();
  if (command === '--start') { console.log(`llm-metis running at ${origin(instance)}`); return; }
  if (command && management.includes(command)) {
    const enabled = args[1] === 'on';
    const patch = command === '--routing' ? { toolRouting: enabled, effortRouting: enabled } : command === '--tool-routing' ? { toolRouting: enabled } : { effortRouting: enabled };
    console.log(JSON.stringify(await api(instance, 'routing', patch))); return;
  }
  if (command === '--dashboard') {
    const url = `${origin(instance)}/dashboard#token=${instance.token}`;
    const opener = dashboardLaunch(url);
    try {
      const child = spawn(opener.file, opener.args, { stdio: 'ignore', windowsHide: true });
      const [code] = await once(child, 'exit');
      if (code !== 0) throw Error('Browser launch failed');
    } catch { throw Error('Could not open the local dashboard. A desktop browser is required; Linux also needs xdg-open.'); }
    console.log(`Dashboard opened at ${origin(instance)}/dashboard`); return;
  }
  const taskId = randomUUID();
  const started = performance.now();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, METIS_CONTROL_TOKEN: instance.token, METIS_CONTROL_TASK_ID: taskId };
  for (const name of Object.keys(childEnv)) {
    if (Object.values(PROVIDERS).some(({ key }) => key === (process.platform === 'win32' ? name.toUpperCase() : name))) delete childEnv[name];
  }
  const userArgs = command === '--' ? args.slice(1) : args;
  // Codex exec has its own -c parser; root-only overrides can disappear when exec also has -c.
  // Insert before a positional '--', otherwise append within the active command's options.
  const delimiter = userArgs.indexOf('--');
  const at = delimiter < 0 ? userArgs.length : delimiter;
  const launch = codexLaunch(process.env.METIS_CODEX_BIN ?? 'codex', [...userArgs.slice(0, at), ...codexArgs(origin(instance)), ...userArgs.slice(at)], childEnv);
  const child = spawn(launch.file, launch.args, { stdio: 'inherit', env: childEnv });
  // Terminal signals also reach Codex in the foreground group. Let Codex handle Ctrl-C itself.
  const interrupt = () => {}; const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await once(child, 'exit');
    await api(instance, 'task', { id: taskId, cohort: cohort({ toolRouting: Boolean(status.toolRouting), effortRouting: Boolean(status.effortRouting) }), durationMs: performance.now() - started, exitCode: code }).catch(() => {});
    process.exitCode = typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
