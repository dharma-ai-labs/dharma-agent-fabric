#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { CLI_USAGE } from './usage.js';
import {
  findSupportedNodeRuntime,
  isSupportedNodeVersion,
  launchWithRuntime,
  runtimeBootstrapHint,
  selectCliRuntime,
} from './runtime-bootstrap.js';
import { PINNED_NODE_VERSION, defaultDharmaHome, ensurePinnedNodeRuntime } from './pinnedNodeRuntime.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${CLI_USAGE}\n`);
} else if (!isSupportedNodeVersion(process.versions.node)) {
  let failure = '';
  const runtime = await selectCliRuntime({
    version: process.versions.node,
    bootstrapped: Boolean(process.env.DHARMA_NODE_BOOTSTRAPPED),
    findSupported: () => findSupportedNodeRuntime(),
    ensurePinned: () => {
      process.stderr.write(`Node.js ${process.versions.node} is not supported; using Dharma's own pinned Node.js ${PINNED_NODE_VERSION} `
        + 'from the Dharma home (fetched from nodejs.org on first use, SHA-256 checked). Your system Node is not changed.\n');
      return ensurePinnedNodeRuntime({ dharmaHome: defaultDharmaHome() });
    },
  }).catch((error: unknown) => {
    failure = error instanceof Error ? error.message : String(error);
    return null;
  });
  if (!runtime) {
    process.stderr.write(failure
      ? `Unable to fetch the pinned Node.js ${PINNED_NODE_VERSION} runtime (${failure}). Allow access to https://nodejs.org and rerun the same command.\n`
      : `${runtimeBootstrapHint()} Current runtime: ${process.versions.node}.\n`);
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
  const { run, commandExitCode, formatCommandOutput } = await import('./index.js');
  run(args).then((value: unknown) => {
    process.stdout.write(formatCommandOutput(value));
    process.exitCode = commandExitCode(args, value);
    // A hook ends once its output is written: a pending relay socket (up to 90 s) must not keep it alive.
    if (args[0] === 'hook') process.stdout.write('', () => process.exit());
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
