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
      throw Error('Unsupported Codex command shim. Set METIS_CODEX_BIN to codex.exe or its JavaScript entry point.');
    }
  }
  throw Error('Codex executable not found. Install Codex or set METIS_CODEX_BIN.');
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
      // Replace the entire DACL: disabling inheritance alone leaves explicit grants behind.
      const command = `$ErrorActionPreference='Stop';
$acl=[System.Security.AccessControl.FileSecurity]::new();
$acl.SetAccessRuleProtection($true,$false);
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow'));
[System.IO.File]::SetAccessControl($env:METIS_PRIVATE_FILE,$acl);`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'METIS_PRIVATE_FILE'));
      await run(windowsSystem('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...env, METIS_PRIVATE_FILE: path }, windowsHide: true, timeout: 10000,
      });
    }
    await file.writeFile(data);
    await file.close();
  } catch (error) { await file.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
}
