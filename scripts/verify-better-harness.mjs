import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pin = JSON.parse(await readFile(resolve(root, 'vendor/better-harness.UPSTREAM.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(resolve(root, 'vendor/better-harness/package.json'), 'utf8'));
const license = await readFile(resolve(root, 'vendor/better-harness/LICENSE'), 'utf8');
const matrix = await readFile(resolve(root, 'vendor/better-harness/docs/adapters/README.md'), 'utf8');

assert.match(pin.commit, /^[a-f0-9]{40}$/);
assert.equal(pin.repository, 'https://github.com/QoderAI/better-harness.git');
assert.equal(packageJson.name, '@qoderai/better-harness');
assert.equal(packageJson.license, 'MIT');
assert.match(license, /MIT License/);
for (const provider of ['Claude Code', 'Codex']) {
  assert.match(matrix, new RegExp(`\\| ${provider.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} \\|`));
}

process.stdout.write(`Verified Better Harness ${packageJson.version} at ${pin.commit}.\n`);
