import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const required = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'LICENSES/Qoder-Better-Harness-MIT.txt',
  '.agents/plugins/marketplace.json',
  'plugins/dharma-agent-fabric/.codex-plugin/plugin.json',
  'plugins/dharma-agent-fabric/.mcp.json',
  'plugins/dharma-agent-fabric/skills/dharma-agent-fabric/SKILL.md',
  'packages/cli/dist/index.js',
  'packages/cli/dist/schemas/trajectory-capsule.schema.json',
  'packages/cli/dist/schemas/evidence-request.schema.json',
  'packages/cli/dist/schemas/evidence-response.schema.json',
];

for (const path of required) await access(resolve(root, path), constants.R_OK);
const notices = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
if (!/Better Harness/i.test(notices) || !/MIT/i.test(notices)) {
  throw new Error('Better Harness attribution is incomplete.');
}

const workspaceDirectories = [
  'packages/contracts',
  'packages/secure-store',
  'packages/policy',
  'packages/provider-adapters',
  'packages/better-harness-bridge',
  'packages/evidence-reduction',
  'packages/relay-client',
  'packages/local-vault',
  'packages/task-runner',
  'packages/skill-manager',
  'packages/sdk',
  'packages/cli',
];

for (const workspace of workspaceDirectories) {
  const manifestPath = resolve(root, workspace, 'package.json');
  const readmePath = resolve(root, workspace, 'README.md');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await access(readmePath, constants.R_OK);
  for (const field of ['description', 'homepage', 'bugs', 'license']) {
    if (!manifest[field]) throw new Error(`${manifest.name} is missing ${field}.`);
  }

  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is required for package verification.');
  const { stdout } = await execFileAsync(
    process.execPath,
    [npmCli, 'pack', '--workspace', workspace, '--dry-run', '--json'],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 },
  );
  const packed = JSON.parse(stdout)[0];
  const packedPaths = new Set(packed.files.map((file) => file.path));
  if (!packedPaths.has('README.md')) {
    throw new Error(`${manifest.name} tarball does not contain README.md.`);
  }
  if (!packedPaths.has('dist/index.js')) {
    throw new Error(`${manifest.name} tarball does not contain dist/index.js.`);
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, requiredFiles: required.length, publicPackages: workspaceDirectories.length })}\n`);
