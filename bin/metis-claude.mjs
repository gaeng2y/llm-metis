#!/usr/bin/env node
import { existsSync } from 'node:fs';
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { main } = await import('../dist/cli.js');
  await main(process.argv.slice(2), 'claude');
} catch (error) {
  if (process.send) { process.send({ ready: false }); process.disconnect(); }
  const message = error?.code === 'ERR_MODULE_NOT_FOUND' ? 'Run npm install && npm run build first.'
    : error?.code === 'EADDRINUSE' ? 'METIS_PORT is already in use.'
    : error?.code === 'ENOENT' ? 'Required executable or file not found. Check Claude Code installation and paths.'
    : error instanceof Error ? error.message : 'Local command failed';
  console.error(`metis-claude: ${message}`);
  process.exitCode = 1;
}
