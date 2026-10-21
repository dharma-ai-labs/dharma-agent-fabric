import { execFile } from 'node:child_process';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertPreservedEvidenceManifest, assertPreservedEvidenceProvider, preservedEvidenceProvider } from './verify-preserved-provider-edge.mjs';

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
  'packages/provider-adapters/dist/knowledge-server.js',
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

const workspaceManifests = new Map();
for (const workspace of workspaceDirectories) {
  const manifest = JSON.parse(await readFile(resolve(root, workspace, 'package.json'), 'utf8'));
  workspaceManifests.set(manifest.name, manifest);
}

const providerAdapter = workspaceManifests.get('@dharma-ai-labs/agent-fabric-provider-adapters');
for (const packageName of ['@dharma-ai-labs/agent-fabric-task-runner']) {
  const manifest = workspaceManifests.get(packageName);
  const pinnedVersion = manifest?.dependencies?.['@dharma-ai-labs/agent-fabric-provider-adapters'];
  if (pinnedVersion !== providerAdapter?.version) {
    throw new Error(
      `${packageName} must use the current provider adapter ${providerAdapter?.version}; found ${pinnedVersion || 'missing'}.`,
    );
  }
}

const cli = workspaceManifests.get('@dharma-ai-labs/agent-fabric');
// Compilation can resolve workspace links even when the published CLI would
// install an older runtime. Check every direct first-party runtime pin.
const cliRuntimePackages = ['contracts', 'evidence-reduction', 'local-vault', 'policy',
  'provider-adapters', 'relay-client', 'sdk', 'secure-store', 'skill-manager', 'task-runner'];
for (const suffix of cliRuntimePackages) {
  const name = `@dharma-ai-labs/agent-fabric-${suffix}`;
  const runtime = workspaceManifests.get(name);
  if (!runtime || cli?.dependencies?.[name] !== runtime.version) {
    throw new Error(`cli_runtime_package_pin_invalid:${suffix}`);
  }
}
for (const name of Object.keys(cli?.dependencies ?? {})) {
  if (name.startsWith('@dharma-ai-labs/') && !workspaceManifests.has(name)) {
    throw new Error('cli_runtime_package_unknown');
  }
}
const evidence = workspaceManifests.get('@dharma-ai-labs/agent-fabric-evidence-reduction');
if (cli.version === preservedEvidenceProvider.newCohort.cli
  || evidence?.version === preservedEvidenceProvider.evidence.version
  || evidence?.dependencies?.[providerAdapter.name] !== providerAdapter.version) {
  assertPreservedEvidenceManifest(evidence);
  const evidenceRoot = resolve(root, 'packages/evidence-reduction');
  const installedRoot = resolve(evidenceRoot, 'node_modules', providerAdapter.name);
  const installedEntry = createRequire(resolve(evidenceRoot, 'package.json')).resolve(providerAdapter.name);
  if (await realpath(installedEntry) !== resolve(installedRoot, 'dist/index.js')
    || (await lstat(installedRoot)).isSymbolicLink()) throw new Error('preserved_provider_resolution_mismatch');
  const runtimeHashes = {};
  let entries = 0, totalBytes = 0;
  async function walk(relative, depth = 0) {
    if (depth > 8) throw new Error('preserved_provider_runtime_bound');
    for (const entry of await readdir(resolve(installedRoot, relative), {withFileTypes: true})) {
      if (++entries > 512 || entry.isSymbolicLink()) throw new Error('preserved_provider_runtime_bound');
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && name.endsWith('.js') && !name.endsWith('.test.js')) {
        const metadata = await lstat(resolve(installedRoot, name));
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024 - totalBytes) {
          throw new Error('preserved_provider_runtime_bound');
        }
        const bytes = await readFile(resolve(installedRoot, name)); totalBytes += bytes.length;
        if (totalBytes > 4 * 1024 * 1024) throw new Error('preserved_provider_runtime_bound');
        runtimeHashes[name] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  await walk('dist');
  const git = async (...args) => (await execFileAsync('git', args, {cwd: root, maxBuffer: 1024 * 1024})).stdout.trim();
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assertPreservedEvidenceProvider({cliVersion: cli.version, providerVersion: providerAdapter.version,
    taskRunnerVersion: workspaceManifests.get('@dharma-ai-labs/agent-fabric-task-runner').version,
    relayClientVersion: workspaceManifests.get('@dharma-ai-labs/agent-fabric-relay-client').version,
    evidenceManifest: evidence, sourceTree: await git('rev-parse', 'HEAD:packages/evidence-reduction'),
    worktreeChanges: await git('diff', '--name-only', 'HEAD', '--', 'packages/evidence-reduction'),
    untracked: await git('ls-files', '--others', '--exclude-standard', '--', 'packages/evidence-reduction'),
    lockEntry: lock.packages?.['packages/evidence-reduction/node_modules/' + providerAdapter.name],
    installedManifest: JSON.parse(await readFile(resolve(installedRoot, 'package.json'), 'utf8')), runtimeHashes});
}
const localVault = workspaceManifests.get('@dharma-ai-labs/agent-fabric-local-vault');
if (cli?.dependencies?.[localVault?.name] !== localVault?.version
  || localVault?.exports?.['./setup-readiness'] !== './dist/setupReadiness.js') {
  throw new Error('CLI must pin the qualified local-vault readiness export.');
}
const skillManager = workspaceManifests.get('@dharma-ai-labs/agent-fabric-skill-manager');
const pinnedSkillManager = cli?.dependencies?.['@dharma-ai-labs/agent-fabric-skill-manager'];
if (pinnedSkillManager !== skillManager?.version) {
  throw new Error(
    `@dharma-ai-labs/agent-fabric must use the current skill manager ${skillManager?.version}; found ${pinnedSkillManager || 'missing'}.`,
  );
}

for (const workspace of workspaceDirectories) {
  const manifestPath = resolve(root, workspace, 'package.json');
  const readmePath = resolve(root, workspace, 'README.md');
  const manifest = workspaceManifests.get(JSON.parse(await readFile(manifestPath, 'utf8')).name);
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
  if (workspace === 'packages/provider-adapters' && !packedPaths.has('dist/knowledge-server.js')) {
    throw new Error(`${manifest.name} tarball does not contain the task knowledge server.`);
  }
  if (workspace === 'packages/local-vault' && (!packedPaths.has('dist/setupReadiness.js')
    || !packedPaths.has('dist/setupReadiness.d.ts'))) throw new Error('Local-vault readiness export is absent from its tarball.');
}

const reference = JSON.parse(await readFile(resolve(root, 'packages/lifecycle-adapter/package.json'), 'utf8'));
if (reference.private !== true || reference.dependencies['@dharma-ai-labs/agent-fabric-contracts'] !== workspaceManifests.get('@dharma-ai-labs/agent-fabric-contracts').version
  || reference.dependencies['@dharma-ai-labs/agent-fabric-evidence-reduction'] !== workspaceManifests.get('@dharma-ai-labs/agent-fabric-evidence-reduction').version
  || reference.dependencies['@dharma-ai-labs/agent-fabric-sdk'] !== workspaceManifests.get('@dharma-ai-labs/agent-fabric-sdk').version) {
  throw new Error('Lifecycle reference must remain private and pin qualified workspace dependencies.');
}
const { stdout: referencePack } = await execFileAsync(process.execPath,
  [process.env.npm_execpath, 'pack', '--workspace', 'packages/lifecycle-adapter', '--dry-run', '--json'], { cwd: root });
const referenceFiles = new Set(JSON.parse(referencePack)[0].files.map(file => file.path));
if ([...referenceFiles].some(file => file.includes('.test.') || /(?:\.env|config\.mjs|\.sqlite|credential|grant)/i.test(file))) {
  throw new Error('Lifecycle reference tarball contains tests or durable runtime data.');
}
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/lifecycle-event.schema.json', 'bin/run.mjs', 'README.md', 'LICENSE']) {
  if (!referenceFiles.has(required)) throw new Error(`Lifecycle reference tarball is missing ${required}.`);
}
process.stdout.write(`${JSON.stringify({ ok: true, requiredFiles: required.length, publicPackages: workspaceDirectories.length, privateReferences: 1 })}\n`);
