import { spawn } from 'node:child_process';
import { randomUUID, createHash, type KeyObject } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { canonicalize, sha256, signCanonicalObject, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { resolveRegisteredCommand, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';

export interface SkillBundle {
  schema: 'dharma.skill-bundle/v2';
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
  targetSelectors: {
    organizationAgentIds: string[];
    deviceIds: string[];
    workspaceIds: string[];
    providers: ProviderId[];
  };
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

export type ProviderActivationCheck = {
  name: string;
  status: 'pass' | 'fail' | 'unavailable';
  details: string | null;
};

export interface ActiveSkillBundleAuthorization {
  bundleId: string;
  bundleHash: string;
  activatedAt: string;
  expiresAt: string | null;
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
  if (bundle.schema !== 'dharma.skill-bundle/v2') {
    throw new Error('Skill bundle schema is not authorized for installation or task execution.');
  }
  if (bundle.expiresAt) {
    const expiresAt = Date.parse(bundle.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Skill bundle expiry is invalid.');
    if (expiresAt <= now.getTime()) throw new Error('Skill bundle has expired.');
  }
  const { signature, ...unsigned } = bundle;
  if (!verifyCanonicalObject(unsigned, signature, serverPublicKey)) throw new Error('Skill bundle signature is invalid.');
  const { bundleHash, ...hashInput } = unsigned;
  if (bundleHash !== calculateBundleHash(hashInput)) throw new Error('Skill bundle hash is invalid.');
  const selectors = bundle.targetSelectors;
  if (!selectors || typeof selectors !== 'object'
    || !Array.isArray(selectors.organizationAgentIds) || !Array.isArray(selectors.deviceIds)
    || !Array.isArray(selectors.workspaceIds) || !Array.isArray(selectors.providers)
    || selectors.organizationAgentIds.some((value) => typeof value !== 'string' || !value)
    || selectors.deviceIds.some((value) => typeof value !== 'string' || !value)
    || selectors.workspaceIds.some((value) => typeof value !== 'string' || !value)
    || selectors.providers.some((value) => !['codex', 'claude', 'agy', 'hermes'].includes(value))) {
    throw new Error('Skill bundle target selectors are invalid.');
  }
}

function assertTargetSelector(selector: string[], value: string, label: string): void {
  if (selector.length > 0 && !selector.includes(value)) {
    throw new Error(`Skill bundle is not authorized for this ${label}.`);
  }
}

function assertBundleTargetsEndpoint(bundle: SkillBundle, endpoint: {
  organizationAgentId: string;
  deviceId: string;
  workspaceId: string;
  provider: ProviderId;
}): void {
  assertTargetSelector(bundle.targetSelectors.organizationAgentIds, endpoint.organizationAgentId, 'repository agent');
  assertTargetSelector(bundle.targetSelectors.deviceIds, endpoint.deviceId, 'device');
  assertTargetSelector(bundle.targetSelectors.workspaceIds, endpoint.workspaceId, 'workspace');
  assertTargetSelector(bundle.targetSelectors.providers, endpoint.provider, 'provider');
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

async function readActiveBundlePointer(root: string): Promise<string | null> {
  let bundleId: string;
  try {
    bundleId = (await readFile(resolve(root, 'ACTIVE_BUNDLE'), 'utf8')).trim();
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!bundleId) return null;
  await recoverRejectedActivation(root, bundleId);
  let manifest: { bundleId?: unknown };
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'active', 'BUNDLE.json'), 'utf8')) as {
      bundleId?: unknown;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Active bundle manifest is missing for the installed bundle pointer.');
    }
    throw error;
  }
  if (manifest.bundleId !== bundleId) {
    throw new Error('Active bundle pointer does not match the installed release manifest.');
  }
  return bundleId;
}

async function readBundleManifestId(path: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { bundleId?: unknown };
    return typeof manifest.bundleId === 'string' ? manifest.bundleId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function recoverRejectedActivation(root: string, bundleId: string): Promise<void> {
  const active = resolve(root, 'active');
  const rollback = resolve(root, 'rollback');
  const activeBundleId = await readBundleManifestId(resolve(active, 'BUNDLE.json'));
  if (activeBundleId === bundleId) return;

  const rollbackBundleId = await readBundleManifestId(resolve(rollback, 'BUNDLE.json'));
  if (rollbackBundleId !== bundleId) return;

  const rejected = resolve(root, '.rejected-activation');
  await rm(rejected, { recursive: true, force: true });
  try {
    await rename(active, rejected);
    await rename(rollback, active);
    await rm(rejected, { recursive: true, force: true });
  } catch (error) {
    if (await pathExists(rejected) && !await pathExists(active)) {
      await rename(rejected, active);
    }
    throw error;
  }
}

function verifyInstallReceipt(
  receipt: InstallReceipt,
  devicePublicKey: KeyObject,
  expected: { bundleId: string; organizationId: string; deviceId: string; workspaceId: string; provider: ProviderId },
  now: Date,
): void {
  const { signature, ...signed } = receipt;
  if (!verifyCanonicalObject(signed, signature, devicePublicKey)) throw new Error('Active bundle install receipt signature is invalid.');
  const { receiptHash, ...hashInput } = signed;
  if (receiptHash !== sha256(canonicalize(hashInput))) throw new Error('Active bundle install receipt hash is invalid.');
  if (receipt.status !== 'active') throw new Error('Active bundle install receipt is not active.');
  if (receipt.bundleId !== expected.bundleId || receipt.organizationId !== expected.organizationId
    || receipt.deviceId !== expected.deviceId || receipt.workspaceId !== expected.workspaceId || receipt.provider !== expected.provider) {
    throw new Error('Active bundle install receipt does not match the selected endpoint.');
  }
  const startedAt = Date.parse(receipt.startedAt);
  const completedAt = Date.parse(receipt.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt || completedAt > now.getTime() + 5_000) {
    throw new Error('Active bundle install receipt has an invalid activation window.');
  }
}

function workspaceManagedRoot(nativeSkillDirectory: string, workspaceId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) {
    throw new Error('Workspace ID is invalid for managed skill state.');
  }
  return resolve(nativeSkillDirectory, '.dharma-managed', 'workspaces', workspaceId);
}

export async function getLegacySkillBundleIdForUpgrade(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
}): Promise<string | null> {
  const root = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const bundleId = await readActiveBundlePointer(root);
  if (!bundleId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bundleId)) {
    throw new Error('Legacy skill bundle identifier is invalid.');
  }
  let authorization: { schema?: unknown; bundleId?: unknown; workspaceId?: unknown; skillIds?: unknown };
  let source: 'authorization' | 'legacy_manifest' = 'authorization';
  try {
    authorization = JSON.parse(await readFile(resolve(root, 'active', 'AUTHORIZATION.json'), 'utf8')) as typeof authorization;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    source = 'legacy_manifest';
    authorization = JSON.parse(await readFile(resolve(root, 'active', 'BUNDLE.json'), 'utf8')) as typeof authorization;
  }
  if (authorization.bundleId !== bundleId) return null;
  if (source === 'authorization') {
    if (authorization.schema !== 'dharma.skill-bundle/v1') return null;
  } else if (authorization.schema !== undefined
    || authorization.workspaceId !== input.workspaceId
    || !Array.isArray(authorization.skillIds)
    || !authorization.skillIds.every((skillId) => typeof skillId === 'string' && skillId.length > 0)) {
    return null;
  }
  return bundleId;
}

export async function getInstalledSkillBundleIdForRecovery(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
}): Promise<string | null> {
  const root = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const bundleId = await readActiveBundlePointer(root);
  if (!bundleId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bundleId)) {
    throw new Error('Installed skill bundle identifier is invalid.');
  }
  let manifest: { schema?: unknown; bundleId?: unknown; workspaceId?: unknown; skillIds?: unknown };
  let source: 'authorization' | 'legacy-manifest' = 'authorization';
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'active', 'AUTHORIZATION.json'), 'utf8')) as typeof manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    source = 'legacy-manifest';
    manifest = JSON.parse(await readFile(resolve(root, 'active', 'BUNDLE.json'), 'utf8')) as typeof manifest;
  }
  const authorizedManifest = source === 'authorization'
    && ['dharma.skill-bundle/v1', 'dharma.skill-bundle/v2'].includes(String(manifest.schema));
  const legacyInstallManifest = source === 'legacy-manifest'
    && manifest.schema === undefined
    && manifest.workspaceId === input.workspaceId
    && Array.isArray(manifest.skillIds)
    && manifest.skillIds.every((skillId) => typeof skillId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId));
  if ((!authorizedManifest && !legacyInstallManifest) || manifest.bundleId !== bundleId) {
    throw new Error('Installed skill recovery metadata is invalid.');
  }
  return bundleId;
}

export async function getExpiredSkillBundleAuthorizationForReplacement(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
  provider: ProviderId;
  organizationId: string;
  organizationAgentId: string;
  deviceId: string;
  serverPublicKey: KeyObject;
  devicePublicKey: KeyObject;
  expectedReceiptHash: string;
  now?: Date;
}): Promise<ActiveSkillBundleAuthorization | null> {
  const root = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const bundleId = await readActiveBundlePointer(root);
  if (!bundleId) return null;
  const bundle = JSON.parse(await readFile(resolve(root, 'active', 'AUTHORIZATION.json'), 'utf8')) as SkillBundle;
  const receipt = JSON.parse(await readFile(resolve(root, 'active', 'INSTALL_RECEIPT.json'), 'utf8')) as InstallReceipt;
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(String(bundle.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) {
    throw new Error('Installed skill bundle is not an expired replacement candidate.');
  }
  if (bundle.bundleId !== bundleId) throw new Error('Active bundle pointer does not match the signed release authorization.');
  verifySkillBundle(bundle, input.serverPublicKey, new Date(expiresAt - 1));
  assertBundleTargetsEndpoint(bundle, input);
  verifyInstallReceipt(receipt, input.devicePublicKey, {
    bundleId,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.provider,
  }, now);
  if (receipt.receiptHash !== input.expectedReceiptHash) {
    throw new Error('Active bundle receipt is not the current protected authorization.');
  }
  return {
    bundleId,
    bundleHash: bundle.bundleHash,
    activatedAt: receipt.completedAt,
    expiresAt: bundle.expiresAt ?? null,
  };
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
  workspaceId: string;
  skillIds: string[];
  removeSkillIds: string[];
}) {
  const affectedSkillIds = [...new Set([...input.removeSkillIds, ...input.skillIds])];
  const sharedActiveSkillIds = new Set<string>();
  await mkdir(input.nativeSkillDirectory, { recursive: true, mode: 0o700 });
  for (const skillId of affectedSkillIds) {
    const target = assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId));
    if (await pathExists(target)) {
      const marker = resolve(target, '.dharma-agent-fabric.json');
      if (!await pathExists(marker)) throw new Error(`Refusing to replace unmanaged provider skill: ${skillId}`);
      const ownership = JSON.parse(await readFile(marker, 'utf8')) as {
        bundleId?: unknown;
        skillId?: unknown;
        workspaceId?: unknown;
      };
      if (typeof ownership.workspaceId === 'string' && ownership.workspaceId !== input.workspaceId) {
        if (ownership.bundleId === input.bundleId
          && ownership.skillId === skillId
          && input.skillIds.includes(skillId)
          && !input.removeSkillIds.includes(skillId)) {
          sharedActiveSkillIds.add(skillId);
        } else {
          throw new Error(`Refusing to replace a provider skill managed by another workspace: ${skillId}`);
        }
      }
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
      if (sharedActiveSkillIds.has(skillId)) continue;
      const source = assertContained(input.release, resolve(input.release, skillId));
      const staged = assertContained(stagedRoot, resolve(stagedRoot, skillId));
      await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
      await writeFile(
        resolve(staged, '.dharma-agent-fabric.json'),
        `${JSON.stringify({ bundleId: input.bundleId, skillId, workspaceId: input.workspaceId })}\n`,
        { mode: 0o600 },
      );
    }
    for (const skillId of affectedSkillIds) {
      if (sharedActiveSkillIds.has(skillId)) continue;
      const target = assertContained(input.nativeSkillDirectory, resolve(input.nativeSkillDirectory, skillId));
      if (!await pathExists(target)) continue;
      await rename(target, assertContained(backupRoot, resolve(backupRoot, skillId)));
      backedUp.push(skillId);
    }
    for (const skillId of input.skillIds) {
      if (sharedActiveSkillIds.has(skillId)) continue;
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

interface RollbackRecoveryManifest {
  schema: 'dharma.skill-rollback-recovery/v1';
  workspaceId: string;
  currentBundleId: string;
  currentSkillIds: string[];
}

async function nativeSkillIdsOwnedByWorkspace(nativeSkillDirectory: string, workspaceId: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(nativeSkillDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const owned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
    try {
      const marker = JSON.parse(await readFile(resolve(nativeSkillDirectory, entry.name, '.dharma-agent-fabric.json'), 'utf8')) as { workspaceId?: unknown };
      if (marker.workspaceId === workspaceId) owned.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return owned;
}

async function recoverInterruptedSkillRollbacks(nativeSkillDirectory: string, workspaceId: string): Promise<void> {
  const managedRoot = workspaceManagedRoot(nativeSkillDirectory, workspaceId);
  let entries;
  try { entries = await readdir(managedRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('.rollback-'))) {
    const transactionRoot = assertContained(managedRoot, resolve(managedRoot, entry.name));
    const manifest = JSON.parse(await readFile(resolve(transactionRoot, 'ROLLBACK_RECOVERY.json'), 'utf8')) as RollbackRecoveryManifest;
    if (manifest.schema !== 'dharma.skill-rollback-recovery/v1'
      || manifest.workspaceId !== workspaceId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.currentBundleId)
      || !Array.isArray(manifest.currentSkillIds)
      || manifest.currentSkillIds.some((skillId) => typeof skillId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId))) {
      throw new Error('Interrupted skill rollback recovery metadata is invalid.');
    }
    const releases = resolve(managedRoot, 'releases');
    const currentRelease = assertContained(releases, resolve(releases, manifest.currentBundleId));
    const active = resolve(managedRoot, 'active');
    const backupActive = resolve(transactionRoot, 'backup-active');
    if (await pathExists(backupActive)) {
      await rm(active, { recursive: true, force: true });
      await rename(backupActive, active);
    } else if (!await pathExists(active)) {
      await cp(currentRelease, active, { recursive: true, errorOnExist: true, force: false });
    }
    await activateNativeSkills({
      nativeSkillDirectory,
      release: currentRelease,
      bundleId: manifest.currentBundleId,
      workspaceId,
      skillIds: manifest.currentSkillIds,
      removeSkillIds: await nativeSkillIdsOwnedByWorkspace(nativeSkillDirectory, workspaceId),
    });
    const pointerTemp = resolve(transactionRoot, 'ACTIVE_BUNDLE.recovery');
    await writeFile(pointerTemp, `${manifest.currentBundleId}\n`, { mode: 0o600 });
    await rename(pointerTemp, resolve(managedRoot, 'ACTIVE_BUNDLE'));
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function getActiveSkillBundleAuthorization(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
  provider: ProviderId;
  organizationId: string;
  organizationAgentId: string;
  deviceId: string;
  serverPublicKey: KeyObject;
  devicePublicKey: KeyObject;
  expectedReceiptHash: string;
  now?: Date;
}): Promise<ActiveSkillBundleAuthorization | null> {
  const root = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const bundleId = await readActiveBundlePointer(root);
  if (!bundleId) return null;
  const bundle = JSON.parse(await readFile(resolve(root, 'active', 'AUTHORIZATION.json'), 'utf8')) as SkillBundle;
  const receipt = JSON.parse(await readFile(resolve(root, 'active', 'INSTALL_RECEIPT.json'), 'utf8')) as InstallReceipt;
  const now = input.now ?? new Date();
  if (bundle.bundleId !== bundleId) throw new Error('Active bundle pointer does not match the signed release authorization.');
  verifySkillBundle(bundle, input.serverPublicKey, now);
  assertBundleTargetsEndpoint(bundle, input);
  verifyInstallReceipt(receipt, input.devicePublicKey, {
    bundleId,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.provider,
  }, now);
  if (receipt.receiptHash !== input.expectedReceiptHash) {
    throw new Error('Active bundle receipt is not the current protected authorization.');
  }
  return {
    bundleId,
    bundleHash: bundle.bundleHash,
    activatedAt: receipt.completedAt,
    expiresAt: bundle.expiresAt ?? null,
  };
}

export async function installSkillBundle(input: {
  bundle: SkillBundle;
  sourceDirectory: string;
  nativeSkillDirectory: string;
  policy: OrganizationPolicy;
  serverPublicKey: KeyObject;
  devicePrivateKey: KeyObject;
  deviceId: string;
  organizationAgentId: string;
  workspaceId: string;
  provider: ProviderId;
  smokeCommandId?: string;
  organizationApprovalId?: string;
  providerActivationCheck?: () => Promise<ProviderActivationCheck>;
}): Promise<InstallReceipt> {
  const startedAt = new Date().toISOString();
  verifySkillBundle(input.bundle, input.serverPublicKey);
  if (input.bundle.organizationId !== input.policy.organizationId) throw new Error('Bundle organization does not match policy.');
  assertBundleTargetsEndpoint(input.bundle, input);
  if (input.bundle.operation === 'clear' && input.bundle.skills.length !== 0) throw new Error('Clear bundles cannot contain skills.');
  if (input.bundle.operation === 'install' && input.bundle.skills.length === 0) throw new Error('Install bundles must contain at least one skill.');
  if ((input.bundle.riskClass === 'R3' || input.bundle.riskClass === 'R4') && !input.organizationApprovalId) {
    throw new Error(`${input.bundle.riskClass} skill bundles require organization approval.`);
  }
  if (!input.policy.skills.automaticInstall) throw new Error('Automatic skill installation is disabled by policy.');

  const managedRoot = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const releases = resolve(managedRoot, 'releases');
  const release = assertContained(releases, resolve(releases, input.bundle.bundleId));
  const active = resolve(managedRoot, 'active');
  const rollback = resolve(managedRoot, 'rollback');
  const previousBundleId = await readActiveBundlePointer(managedRoot);
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
  await writeFile(
    resolve(release, 'BUNDLE.json'),
    `${JSON.stringify({ bundleId: input.bundle.bundleId, workspaceId: input.workspaceId, skillIds })}\n`,
    { mode: 0o600 },
  );
  await writeFile(resolve(release, 'AUTHORIZATION.json'), `${JSON.stringify(input.bundle)}\n`, { mode: 0o600 });
  const previousRelease = previousBundleId ? resolve(releases, previousBundleId) : null;
  const previousSkillIds = previousRelease ? await releaseSkillIds(previousRelease) : [];

  await rm(rollback, { recursive: true, force: true });
  try { await rename(active, rollback); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await cp(release, active, { recursive: true, errorOnExist: true, force: false });
  try {
    await activateNativeSkills({
      nativeSkillDirectory: input.nativeSkillDirectory,
      release,
      bundleId: input.bundle.bundleId,
      workspaceId: input.workspaceId,
      skillIds,
      removeSkillIds: previousSkillIds,
    });
  } catch (error) {
    await rm(active, { recursive: true, force: true });
    try { await rename(rollback, active); }
    catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, restoreError], 'Native skill activation failed and the prior managed release could not be restored.');
      }
    }
    throw error;
  }
  let status: InstallReceipt['status'] = 'active';
  const restorePreviousBundle = async (): Promise<InstallReceipt['status']> => {
    await rm(active, { recursive: true, force: true });
    let restored: InstallReceipt['status'] = 'failed';
    try { await rename(rollback, active); restored = 'rolled_back'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await activateNativeSkills({
      nativeSkillDirectory: input.nativeSkillDirectory,
      release: previousRelease || release,
      bundleId: previousBundleId || input.bundle.bundleId,
      workspaceId: input.workspaceId,
      skillIds: previousBundleId ? previousSkillIds : [],
      removeSkillIds: skillIds,
    });
    return restored;
  };
  if (input.smokeCommandId) {
    const check = await runSmoke(input.smokeCommandId, input.policy, active);
    checks.push({ name: `smoke:${input.smokeCommandId}`, ...check });
    if (check.status === 'fail') {
      status = await restorePreviousBundle();
    }
  }
  if (status === 'active') {
    try {
      verifySkillBundle(input.bundle, input.serverPublicKey);
      checks.push({ name: 'authorization:activation-window', status: 'pass', details: input.bundle.expiresAt || 'no-expiry' });
    } catch (error) {
      checks.push({
        name: 'authorization:activation-window',
        status: 'fail',
        details: error instanceof Error ? error.message : String(error),
      });
      status = await restorePreviousBundle();
    }
  }
  if (status === 'active' && input.providerActivationCheck) {
    let check: ProviderActivationCheck;
    try {
      check = await input.providerActivationCheck();
      if (!/^provider:[a-z0-9._-]+:activation$/.test(check.name)
        || !['pass', 'fail', 'unavailable'].includes(check.status)
        || (check.details !== null && (typeof check.details !== 'string' || check.details.length > 1_000))) {
        throw new Error('Provider activation check returned an invalid result.');
      }
    } catch (error) {
      check = {
        name: `provider:${input.provider}:activation`,
        status: 'fail',
        details: error instanceof Error ? error.message.slice(0, 1_000) : 'Provider activation check failed.',
      };
    }
    checks.push(check);
    if (check.status === 'fail') status = await restorePreviousBundle();
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
  const receipt = { ...receiptBase, receiptHash, signature };
  if (status === 'active') {
    try {
      await writeFile(resolve(release, 'INSTALL_RECEIPT.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      await writeFile(resolve(active, 'INSTALL_RECEIPT.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      await writeFile(resolve(managedRoot, 'ACTIVE_BUNDLE'), `${input.bundle.bundleId}\n`, { mode: 0o600 });
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      try { await restorePreviousBundle(); }
      catch (recoveryError) { recoveryErrors.push(recoveryError); }
      try {
        if (previousBundleId) {
          await writeFile(resolve(managedRoot, 'ACTIVE_BUNDLE'), `${previousBundleId}\n`, { mode: 0o600 });
        } else {
          await rm(resolve(managedRoot, 'ACTIVE_BUNDLE'), { force: true });
        }
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
      if (recoveryErrors.length) {
        throw new AggregateError([error, ...recoveryErrors], 'Skill receipt persistence failed and local recovery was incomplete.');
      }
      throw error;
    }
  } else if (previousBundleId) {
    await writeFile(resolve(managedRoot, 'ACTIVE_BUNDLE'), `${previousBundleId}\n`, { mode: 0o600 });
  } else {
    await rm(resolve(managedRoot, 'ACTIVE_BUNDLE'), { force: true });
  }
  return receipt;
}

export async function rollbackUnconfirmedSkillBundle(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
  receipt: InstallReceipt;
}): Promise<void> {
  if (input.receipt.status !== 'active') return;
  const managedRoot = workspaceManagedRoot(input.nativeSkillDirectory, input.workspaceId);
  await recoverInterruptedSkillRollbacks(input.nativeSkillDirectory, input.workspaceId);
  const activeBundleId = await readActiveBundlePointer(managedRoot);
  if (activeBundleId !== input.receipt.bundleId) {
    throw new Error('Refusing to roll back an installation that is no longer the active local bundle.');
  }
  const releases = resolve(managedRoot, 'releases');
  const active = resolve(managedRoot, 'active');
  const currentRelease = assertContained(releases, resolve(releases, input.receipt.bundleId));
  const currentSkillIds = await releaseSkillIds(currentRelease);
  const previousBundleId = input.receipt.previousBundleId;
  const previousRelease = previousBundleId
    ? assertContained(releases, resolve(releases, previousBundleId))
    : null;
  const previousSkillIds = previousRelease ? await releaseSkillIds(previousRelease) : [];
  const transactionRoot = assertContained(managedRoot, resolve(managedRoot, `.rollback-${randomUUID()}`));
  const stagedActive = resolve(transactionRoot, 'staged-active');
  const backupActive = resolve(transactionRoot, 'backup-active');
  const pointer = resolve(managedRoot, 'ACTIVE_BUNDLE');
  const pointerTemp = resolve(transactionRoot, 'ACTIVE_BUNDLE.next');
  let nativeChanged = false;
  let activeMoved = false;
  let stagedMoved = false;
  let preserveRecovery = false;
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(transactionRoot, 'ROLLBACK_RECOVERY.json'), `${JSON.stringify({
    schema: 'dharma.skill-rollback-recovery/v1',
    workspaceId: input.workspaceId,
    currentBundleId: input.receipt.bundleId,
    currentSkillIds,
  } satisfies RollbackRecoveryManifest)}\n`, { mode: 0o600 });
  if (previousRelease) {
    await cp(previousRelease, stagedActive, { recursive: true, errorOnExist: true, force: false });
  }
  try {
    await activateNativeSkills({
      nativeSkillDirectory: input.nativeSkillDirectory,
      release: previousRelease || currentRelease,
      bundleId: previousBundleId || input.receipt.bundleId,
      workspaceId: input.workspaceId,
      skillIds: previousSkillIds,
      removeSkillIds: currentSkillIds,
    });
    nativeChanged = true;
    await rename(active, backupActive);
    activeMoved = true;
    if (previousRelease) {
      await rename(stagedActive, active);
      stagedMoved = true;
      await writeFile(pointerTemp, `${previousBundleId}\n`, { mode: 0o600 });
      await rename(pointerTemp, pointer);
    } else {
      await rm(pointer, { force: true });
    }
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    if (activeMoved) {
      try {
        if (stagedMoved) await rm(active, { recursive: true, force: true });
        await rename(backupActive, active);
      } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    if (nativeChanged) {
      try {
        await activateNativeSkills({
          nativeSkillDirectory: input.nativeSkillDirectory,
          release: currentRelease,
          bundleId: input.receipt.bundleId,
          workspaceId: input.workspaceId,
          skillIds: currentSkillIds,
          removeSkillIds: previousSkillIds,
        });
      } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    try { await writeFile(pointer, `${input.receipt.bundleId}\n`, { mode: 0o600 }); }
    catch (recoveryError) { recoveryErrors.push(recoveryError); }
    if (recoveryErrors.length) {
      preserveRecovery = true;
      throw new AggregateError([error, ...recoveryErrors], 'Skill rollback failed and the active installation could not be fully restored.');
    }
    throw error;
  } finally {
    if (!preserveRecovery) await rm(transactionRoot, { recursive: true, force: true });
  }
}

export { contentHash };
