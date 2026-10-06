import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
type Launch = { file: string; args: string[] };
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const windowsSystem = (name: string) => win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

/** Preserve argv, including TOML quotes and prompts, without a command shell. */
export function codexLaunch(binary: string, args: string[], env = process.env, platform = process.platform, exists = isFile): Launch {
  if (/\.(?:mjs|cjs|js)$/i.test(binary)) return { file: process.execPath, args: [binary, ...args] };
  if (platform !== 'win32') return { file: binary, args };
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const bases = win32.basename(binary) !== binary ? [win32.resolve(binary)]
    : path.split(';').filter(Boolean).map(dir => win32.join(dir.replace(/^"|"$/g, ''), binary));
  for (const base of bases) {
    for (const file of win32.extname(base) ? [base] : [`${base}.exe`, `${base}.com`, `${base}.cmd`, `${base}.bat`]) {
      if (!exists(file)) continue;
      if (!/\.(?:cmd|bat)$/i.test(file)) return { file, args };
      // npm creates .cmd shims; execute Codex's JS entry instead of interpreting the shim.
      if (/^codex\.(?:cmd|bat)$/i.test(win32.basename(file))) {
        const dir = win32.dirname(file);
        for (const entry of [win32.join(dir, 'node_modules/@openai/codex/bin/codex.js'), win32.join(dir, '../@openai/codex/bin/codex.js')]) {
          if (exists(entry)) return { file: process.execPath, args: [entry, ...args] };
        }
      }
      throw Error('Unsupported Codex command shim. Set JEV_CODEX_BIN to codex.exe or its JavaScript entry point.');
    }
  }
  throw Error('Codex executable not found. Install Codex or set JEV_CODEX_BIN.');
}

export function dashboardLaunch(url: string, platform = process.platform): Launch {
  if (platform === 'win32') return { file: windowsSystem('rundll32.exe'), args: [`${windowsSystem('url.dll')},FileProtocolHandler`, url] };
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** Set Windows permissions on an empty file before writing the private token. */
export async function writePrivateFile(path: string, data: string, platform = process.platform, run = exec) {
  const file = await open(path, 'wx', 0o600);
  try {
    if (platform === 'win32') {
      const { stdout } = await run(windowsSystem('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw Error('Cannot determine the current Windows user');
      await run(windowsSystem('icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true });
    }
    await file.writeFile(data);
    await file.close();
  } catch (error) { await file.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
}
