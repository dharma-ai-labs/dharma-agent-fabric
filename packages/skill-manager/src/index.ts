import { spawn } from 'node:child_process';
import { randomUUID, createHash, type KeyObject } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { canonicalize, sha256, signCanonicalObject, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { resolveRegisteredCommand, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';

export interface SkillBundle {
  schema: 'dharma.skill-bundle/v1';
  bundleId: string;
  organizationId: string;
  version: string;
  operation: 'install' | 'clear';
  skills: Array<{
    skillId: string;
    version: string;
    repository: string;
    commit: string;
    contentHash: string;
    path: string;
    files?: Array<{ path: string; contentBase64: string; sha256: string }>;
  }>;
  riskClass: 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
  targetSelectors: Record<string, unknown>;
  activationPolicy: 'next_task' | 'next_session' | 'host_restart' | 'immediate_safe_reload';
  rollbackBundleId: string | null;
  evaluationReceiptId: string;
  bundleHash: string;
  createdAt: string;
  expiresAt?: string | null;
  signature: string;
}

export interface InstallReceipt {
  schema: 'dharma.install-receipt/v1';
  installationId: string;
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  provider: string;
  bundleId: string;
  previousBundleId: string | null;
  status: 'active' | 'failed' | 'rolled_back';
  activationMode: string;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'unavailable'; details: string | null }>;
  startedAt: string;
  completedAt: string;
  rollbackReceiptId: string | null;
  receiptHash: string;
  signature: string;
}

function assertContained(root: string, candidate: string): string {
  const route = relative(resolve(root), resolve(candidate));
  if (route === '..' || route.startsWith('../') || route.startsWith('..\\') || isAbsolute(route)) {
    throw new Error('Skill path escapes its bundle root.');
  }
  return resolve(candidate);
}

async function contentHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (entryPath: string, prefix = ''): Promise<void> => {
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error('Skill bundles cannot contain symbolic links.');
    if (metadata.isDirectory()) {
      for (const name of (await readdir(entryPath)).sort()) await visit(resolve(entryPath, name), `${prefix}${name}/`);
      return;
    }
    if (!metadata.isFile()) throw new Error('Skill bundles may contain only files and directories.');
    hash.update(prefix.slice(0, -1));
    hash.update('\0');
    hash.update(await readFile(entryPath));
    hash.update('\0');
  };
  await visit(path, basename(path) + '/');
  return `sha256:${hash.digest('hex')}`;
}

export function calculateBundleHash(bundle: Omit<SkillBundle, 'signature' | 'bundleHash'>): string {
  return sha256(canonicalize(bundle));
}

export function verifySkillBundle(bundle: SkillBundle, serverPublicKey: KeyObject, now = new Date()): void {
  if (bundle.expiresAt && Date.parse(bundle.expiresAt) <= now.getTime()) throw new Error('Skill bundle has expired.');
  const { signature, ...unsigned } = bundle;
  if (!verifyCanonicalObject(unsigned, signature, serverPublicKey)) throw new Error('Skill bundle signature is invalid.');
  const { bundleHash, ...hashInput } = unsigned;
  if (bundleHash !== calculateBundleHash(hashInput)) throw new Error('Skill bundle hash is invalid.');
}

async function runSmoke(commandId: string, policy: OrganizationPolicy, cwd: string): Promise<{ status: 'pass' | 'fail'; details: string | null }> {
  const command = resolveRegisteredCommand(policy, commandId);
  const [executable, ...argv] = command.argv;
  return new Promise((accept, reject) => {
    const child = spawn(executable!, argv, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill('SIGKILL'), command.timeoutSeconds * 1_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      accept({ status: code === 0 ? 'pass' : 'fail', details: code === 0 ? null : Buffer.concat(stderr).toString('utf8').slice(0, 500) });
    });
  });
}

async function readActiveBundleId(root: string): Promise<string | null> {
  try { return (await readFile(resolve(root, 'ACTIVE_BUNDLE'), 'utf8')).trim() || null; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function releaseSkillIds(release: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(resolve(release, 'BUNDLE.json'), 'utf8')) as { skillIds?: unknown };
    return Array.isArray(manifest.skillIds) && manifest.skillIds.every((item) => typeof item === 'string') ? manifest.skillIds : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function activateNativeSkills(input: {
  nativeSkillDirectory: string;
  release: string;
  bundleId: string;
  skillIds: string[];
  removeSkillIds: string[];
}) {
  const affectedSkillIds = [...new Set([...input.removeSkillIds, ...input.skillIds])];
  await mkdir(input.nativeSkillDirectory, { recursive: true, mode: 0o700 });
  for (const skillId of affectedSkillIds) {
    const target = assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId));
    if (await pathExists(target)) {
      const marker = resolve(target, '.dharma-agent-fabric.json');
      if (!await pathExists(marker)) throw new Error(`Refusing to replace unmanaged provider skill: ${skillId}`);
    }
  }

  const transactionRoot = assertContained(
    input.nativeSkillDirectory,
    resolve(input.nativeSkillDirectory, `.dharma-activation-${randomUUID()}`),
  );
  const stagedRoot = resolve(transactionRoot, 'staged');
  const backupRoot = resolve(transactionRoot, 'backup');
  const backedUp: string[] = [];
  const activated: string[] = [];
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  try {
    for (const skillId of input.skillIds) {
      const source = assertContained(input.release, resolve(input.release, skillId));
      const staged = assertContained(stagedRoot, resolve(stagedRoot, skillId));
      await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
      await writeFile(
        resolve(staged, '.dharma-agent-fabric.json'),
        `${JSON.stringify({ bundleId: input.bundleId, skillId })}\n`,
        { mode: 0o600 },
      );
    }
    for (const skillId of affectedSkillIds) {
      const target = assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId));
      if (!await pathExists(target)) continue;
      await rename(target, assertContained(backupRoot, resolve(backupRoot, skillId)));
      backedUp.push(skillId);
    }
    for (const skillId of input.skillIds) {
      const target = assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId));
      await rename(assertContained(stagedRoot, resolve(stagedRoot, skillId)), target);
      activated.push(skillId);
    }
  } catch (error) {
    for (const skillId of activated.reverse()) {
      await rm(assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId)), {
        recursive: true,
        force: true,
      });
    }
    for (const skillId of backedUp.reverse()) {
      await rename(
        assertContained(backupRoot, resolve(backupRoot, skillId)),
        assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId)),
      );
    }
    throw error;
  } finally {
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function getActiveSkillBundleId(nativeSkillDirectory: string) {
  return readActiveBundleId(resolve(nativeSkillDirectory, '.dharma-managed'));
}

export async function installSkillBundle(input: {
  bundle: SkillBundle;
  sourceDirectory: string;
  nativeSkillDirectory: string;
  policy: OrganizationPolicy;
  serverPublicKey: KeyObject;
  devicePrivateKey: KeyObject;
  deviceId: string;
  workspaceId: string;
  provider: ProviderId;
  smokeCommandId?: string;
  organizationApprovalId?: string;
}): Promise<InstallReceipt> {
  const startedAt = new Date().toISOString();
  verifySkillBundle(input.bundle, input.serverPublicKey);
  if (input.bundle.organizationId !== input.policy.organizationId) throw new Error('Bundle organization does not match policy.');
  if (input.bundle.operation === 'clear' && input.bundle.skills.length !== 0) throw new Error('Clear bundles cannot contain skills.');
  if (input.bundle.operation === 'install' && input.bundle.skills.length === 0) throw new Error('Install bundles must contain at least one skill.');
  if ((input.bundle.riskClass === 'R3' || input.bundle.riskClass === 'R4') && !input.organizationApprovalId) {
    throw new Error(`${input.bundle.riskClass} skill bundles require organization approval.`);
  }
  if (!input.policy.skills.automaticInstall) throw new Error('Automatic skill installation is disabled by policy.');

  const managedRoot = resolve(input.nativeSkillDirectory, '.dharma-managed');
  const releases = resolve(managedRoot, 'releases');
  const release = assertContained(releases, resolve(releases, input.bundle.bundleId));
  const active = resolve(managedRoot, 'active');
  const rollback = resolve(managedRoot, 'rollback');
  const previousBundleId = await readActiveBundleId(managedRoot);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await rm(release, { recursive: true, force: true });
  await mkdir(release, { recursive: true, mode: 0o700 });
  const checks: InstallReceipt['checks'] = [];
  for (const skill of input.bundle.skills) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skill.skillId)) throw new Error(`Invalid provider skill identifier: ${skill.skillId}`);
    const source = assertContained(input.sourceDirectory, resolve(input.sourceDirectory, skill.path));
    const actualHash = await contentHash(source);
    if (actualHash !== skill.contentHash) throw new Error(`Skill content hash mismatch: ${skill.skillId}`);
    await cp(source, resolve(release, skill.skillId), { recursive: true, errorOnExist: true, force: false });
    checks.push({ name: `content:${skill.skillId}`, status: 'pass', details: actualHash });
  }
  const skillIds = input.bundle.skills.map((skill) => skill.skillId);
  await writeFile(resolve(release, 'BUNDLE.json'), `${JSON.stringify({ bundleId: input.bundle.bundleId, skillIds })}\n`, { mode: 0o600 });
  const previousRelease = previousBundleId ? resolve(releases, previousBundleId) : null;
  const previousSkillIds = previousRelease ? await releaseSkillIds(previousRelease) : [];

  await rm(rollback, { recursive: true, force: true });
  try { await rename(active, rollback); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await cp(release, active, { recursive: true, errorOnExist: true, force: false });
  await activateNativeSkills({
    nativeSkillDirectory: input.nativeSkillDirectory,
    release,
    bundleId: input.bundle.bundleId,
    skillIds,
    removeSkillIds: previousSkillIds,
  });
  let status: InstallReceipt['status'] = 'active';
  if (input.smokeCommandId) {
    const check = await runSmoke(input.smokeCommandId, input.policy, active);
    checks.push({ name: `smoke:${input.smokeCommandId}`, ...check });
    if (check.status === 'fail') {
      await rm(active, { recursive: true, force: true });
      try { await rename(rollback, active); status = 'rolled_back'; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        status = 'failed';
      }
      await activateNativeSkills({
        nativeSkillDirectory: input.nativeSkillDirectory,
        release: previousRelease || release,
        bundleId: previousBundleId || input.bundle.bundleId,
        skillIds: previousBundleId ? previousSkillIds : [],
        removeSkillIds: skillIds,
      });
    }
  }
  if (status === 'active') {
    await rm(rollback, { recursive: true, force: true });
    await writeFile(resolve(managedRoot, 'ACTIVE_BUNDLE'), `${input.bundle.bundleId}\n`, { mode: 0o600 });
  } else if (previousBundleId) {
    await writeFile(resolve(managedRoot, 'ACTIVE_BUNDLE'), `${previousBundleId}\n`, { mode: 0o600 });
  } else {
    await rm(resolve(managedRoot, 'ACTIVE_BUNDLE'), { force: true });
  }

  const receiptBase = {
    schema: 'dharma.install-receipt/v1' as const,
    installationId: randomUUID(),
    organizationId: input.bundle.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    bundleId: input.bundle.bundleId,
    previousBundleId,
    status,
    activationMode: input.bundle.activationPolicy,
    checks,
    startedAt,
    completedAt: new Date().toISOString(),
    rollbackReceiptId: null,
  };
  const receiptHash = sha256(canonicalize(receiptBase));
  const signature = signCanonicalObject({ ...receiptBase, receiptHash }, input.devicePrivateKey);
  return { ...receiptBase, receiptHash, signature };
}

export { contentHash };
