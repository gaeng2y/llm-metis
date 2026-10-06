import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PROVIDERS, normalizedEnv, type Provider } from './config.js';
import { object } from './decision.js';
import { writePrivateFile } from './platform.js';

interface Settings { provider: Provider; keys: Partial<Record<Provider, string>> }
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[\x21-\x7e]{1,8192}$/.test(key);
const providerName = (value: string): Provider => {
  const name = value.trim().toLowerCase();
  if (!Object.hasOwn(PROVIDERS, name)) throw Error('Provider must be openrouter, vercel, or typesafe.');
  return name as Provider;
};
export const configPath = (env = process.env) => resolve(env.METIS_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'llm-metis', 'config.json'));

async function readSettings(env = process.env): Promise<Settings> {
  let data: string;
  try { data = await readFile(configPath(env), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { provider: 'openrouter', keys: {} };
    throw Error('Cannot read saved configuration. Check the file shown by metis-codex config-path.');
  }
  try {
    const value: unknown = JSON.parse(data);
    if (!object(value) || typeof value.provider !== 'string' || !Object.hasOwn(PROVIDERS, value.provider) || !object(value.keys)) throw Error();
    if (Object.entries(value.keys).some(([name, key]) => !Object.hasOwn(PROVIDERS, name) || !validKey(key))) throw Error();
    return { provider: value.provider as Provider, keys: value.keys as Settings['keys'] };
  } catch { throw Error('Invalid saved configuration. Check the file shown by metis-codex config-path.'); }
}

/** Saved credentials are consumed by the daemon, never added to the Codex child environment. */
export async function configuredEnv(env = process.env): Promise<NodeJS.ProcessEnv> {
  const result = normalizedEnv(env);
  const saved = await readSettings(result);
  if (!result.METIS_PROVIDER?.trim()) result.METIS_PROVIDER = saved.provider;
  for (const [provider, { key }] of Object.entries(PROVIDERS)) {
    if (!result[key]?.trim() && saved.keys[provider as Provider]) result[key] = saved.keys[provider as Provider];
  }
  return result;
}

export const configureHelp = `metis-codex configure [--provider openrouter|vercel|typesafe] [--key-stdin]
  Select a provider and enter its API key (hidden input).
  Press Enter to keep an existing saved key.
  --key-stdin reads the key from standard input without printing it.
  configuration is an alias for configure; config-path shows the saved file.
  Nonempty environment/.env values override saved settings.`;

export async function configure(args: string[]) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(configureHelp); return false; }
  let provider: Provider | undefined;
  let keyStdin = false;
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--provider' && !provider && args[n + 1]) provider = providerName(args[++n]!);
    else if (args[n] === '--key-stdin' && !keyStdin) keyStdin = true;
    else throw Error(configureHelp);
  }
  const saved = await readSettings();
  let key: string | undefined;
  if (keyStdin) {
    provider ??= saved.provider;
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk.toString();
      if (data.length > 8194) throw Error('API key is too long.');
    }
    key = data.trim();
    if (!validKey(key)) throw Error('API key must be nonempty printable ASCII without whitespace.');
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    let hidden = false;
    const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    const cancelled = new AbortController();
    rl.on('SIGINT', () => cancelled.abort());
    rl.on('close', () => cancelled.abort());
    try {
      provider ??= providerName((await rl.question(`Provider (openrouter/vercel/typesafe) [${saved.provider}]: `, { signal: cancelled.signal })).trim() || saved.provider);
      process.stdout.write(`${provider} API key${saved.keys[provider] ? ' (Enter to keep saved key)' : ''}: `);
      hidden = true;
      key = (await rl.question('', { signal: cancelled.signal })).trim() || saved.keys[provider];
    } catch (error) {
      if (cancelled.signal.aborted) throw Error('Configuration cancelled; no changes saved.');
      throw error;
    } finally { rl.close(); output.end(); if (hidden) process.stdout.write('\n'); }
  } else {
    provider ??= saved.provider;
    key = saved.keys[provider];
    if (!key) throw Error('Use an interactive terminal or --key-stdin to enter the API key.');
  }
  if (!provider || !validKey(key)) throw Error('API key must be nonempty printable ASCII without whitespace.');
  const file = configPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writePrivateFile(temporary, `${JSON.stringify({ provider, keys: { ...saved.keys, [provider]: key } }, null, 2)}\n`);
    await rename(temporary, file);
  } catch { throw Error('Cannot save private configuration. Check the file shown by metis-codex config-path.'); }
  finally { await unlink(temporary).catch(() => {}); }
  console.log(`Saved ${provider} configuration to ${file}. No provider request was made.`);
  if (process.env.METIS_PROVIDER?.trim() && process.env.METIS_PROVIDER.trim().toLowerCase() !== provider) console.log('METIS_PROVIDER in the environment/.env overrides the saved provider.');
  if (process.env[PROVIDERS[provider].key]?.trim()) console.log(`${PROVIDERS[provider].key} in the environment/.env overrides the saved key.`);
  if (process.env.METIS_URL || process.env.METIS_MODEL) console.log('METIS_URL/METIS_MODEL in the environment/.env still override provider defaults.');
  return true;
}
