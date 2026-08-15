#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { CLI_USAGE } from './usage.js';
import {
  findSupportedNodeRuntime,
  isSupportedNodeVersion,
  launchWithRuntime,
  runtimeBootstrapHint,
} from './runtime-bootstrap.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${CLI_USAGE}\n`);
} else if (!isSupportedNodeVersion(process.versions.node)) {
  const runtime = process.env.DHARMA_NODE_BOOTSTRAPPED ? null : findSupportedNodeRuntime();
  if (!runtime) {
    process.stderr.write(`${runtimeBootstrapHint()} Current runtime: ${process.versions.node}.\n`);
    process.exitCode = 1;
  } else {
    const child = launchWithRuntime(runtime, fileURLToPath(import.meta.url), args, process.env);
    if (child.error) {
      process.stderr.write(`Unable to start the supported Dharma Node.js runtime: ${child.error.message}\n`);
      process.exitCode = 1;
    } else if (child.signal) {
      process.kill(process.pid, child.signal);
    } else {
      process.exitCode = child.status ?? 1;
    }
  }
} else {
  const { run } = await import('./index.js');
  run(args).then((value: unknown) => {
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
