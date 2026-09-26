#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LifecycleAdapterError, previewLifecycleSource, SqliteLifecycleAdapter } from '../dist/index.js';

try {
  const args = process.argv.slice(2);
  const index = args.indexOf('--config');
  const path = index >= 0 ? args[index + 1] : null;
  if (!path || !isAbsolute(path) || args.filter(a => a === '--config').length !== 1
    || args.some((a, i) => i !== index + 1 && !['--config', '--dry-run', '--apply'].includes(a))
    || (args.includes('--dry-run') && args.includes('--apply'))) throw new LifecycleAdapterError('lifecycle_runner_arguments_invalid');
  const config = (await import(pathToFileURL(path).href)).default;
  if (!args.includes('--apply')) {
    const preview = await previewLifecycleSource(config);
    const events = preview.map(({ handoff: _handoff, idempotencyKey: _key, ...metadata }) => metadata);
    process.stdout.write(`${JSON.stringify({ state: 'preview', events, executionVerified: false })}\n`);
  } else {
    const adapter = await SqliteLifecycleAdapter.open(config);
    try {
      const result = await adapter.run(await config.createClient());
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.state === 'blocked') process.exitCode = 1;
    } finally { adapter.close(); }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ state: 'blocked', code: error instanceof LifecycleAdapterError
    ? error.code : 'lifecycle_runner_failure', executionVerified: false })}\n`);
  process.exitCode = 1;
}
