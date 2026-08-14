#!/usr/bin/env node

import { CLI_USAGE } from './usage.js';

const args = process.argv.slice(2);
const [major, minor] = process.versions.node.split('.').map(Number);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${CLI_USAGE}\n`);
} else if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 20)) {
  process.stderr.write(
    `Dharma Agent Fabric requires Node.js 22.20 or newer. Current runtime: ${process.versions.node}. `
    + 'Install the current Node.js 22 LTS release, reopen the terminal, and rerun the command.\n',
  );
  process.exitCode = 1;
} else {
  const { run } = await import('./index.js');
  run(args).then((value: unknown) => {
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
