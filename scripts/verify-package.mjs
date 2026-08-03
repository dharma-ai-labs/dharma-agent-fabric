import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'LICENSES/Qoder-Better-Harness-MIT.txt',
  'plugin/.codex-plugin/plugin.json',
  'plugin/skills/dharma-agent-fabric/SKILL.md',
  'packages/cli/dist/index.js',
];

for (const path of required) await access(resolve(root, path), constants.R_OK);
const notices = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
if (!/Better Harness/i.test(notices) || !/MIT/i.test(notices)) {
  throw new Error('Better Harness attribution is incomplete.');
}
process.stdout.write(`${JSON.stringify({ ok: true, requiredFiles: required.length })}\n`);
