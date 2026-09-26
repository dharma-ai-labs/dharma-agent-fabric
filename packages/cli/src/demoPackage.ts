import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { deleteActiveSkillAuthorizationAnchor, loadActiveSkillAuthorizationAnchor,
  loadOrCreateDeviceIdentity, normalizeHqUrl,
  saveActiveSkillAuthorizationAnchor, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { getActiveSkillBundleAuthorization, installSkillBundle, rollbackUnconfirmedSkillBundle,
  verifySkillBundle, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { loadDemoSigningTrust, scopePath, verifyDemoDevice, type DemoDeviceScope } from './demoEnrollment.js';
import { receiveRepositoryPackageDelivery } from './repositoryPackageDelivery.js';
import { inventoryRepositoryPackage, readRepositoryPackageSnapshot, rebuildRepositoryPackageSnapshot,
  writeRepositoryPackageSnapshot } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';
import { assertRepositoryInstallerOwnership, writeRepositoryInstallerFile } from './repositoryInstallerFiles.js';
import { pollRepositoryCandidate, synchronizeRepositoryCandidate,
  type RepositoryCandidateTransport } from './repositoryCandidateSync.js';
import { validateRepositorySourceAuthorization,
  type RepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import { observeDemoSource, readDemoSourceBaseline, writeDemoSourceBaseline } from './demoSourceBaseline.js';
import { readDemoSourceHistory, writeDemoSourceHistory } from './demoSourceHistory.js';
import { fetchPublishedRepositorySource } from './repositorySourceInventoryClient.js';
import { reconcileRepositorySourceSnapshot } from './repositorySourceReconciliation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DeviceConfig = {
  schema: string; hqUrl: string; organizationId: string; repositoryId: string;
  normalizedRepository: string; installationId: string; deviceId: string;
  publicKeyEd25519: string; signedReady: boolean; nextSequence: number;
};

export interface DemoPackageDependencies { store?: SecureSecretStore; fetcher?: typeof fetch; now?: () => number }

function apiError(value: unknown, status: number) {
  const response = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const nested = response.error && typeof response.error === 'object' && !Array.isArray(response.error)
    ? response.error as Record<string, unknown> : null;
  const code = typeof nested?.code === 'string' ? nested.code
    : typeof response.error === 'string' ? response.error : `http_${status}`;
  const message = typeof nested?.message === 'string' ? nested.message
    : typeof response.message === 'string' ? response.message : 'Demo package request failed.';
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

async function signedJson(input: DemoDeviceScope, method: 'GET' | 'POST', route: string,
  body: unknown, deps: DemoPackageDependencies): Promise<Record<string, unknown>> {
  const origin = normalizeHqUrl(input.hqUrl);
  const url = new URL(route, origin);
  if (url.origin !== origin || !url.pathname.startsWith(`/api/demo/fabric/repositories/${input.repositoryId}/`)) {
    throw new Error('Demo package route does not match the enrolled repository.');
  }
  url.searchParams.set('orgId', input.organizationId);
  const rawBody = method === 'POST' ? JSON.stringify(body) : '';
  if (Buffer.byteLength(rawBody) > 8_388_608) throw new Error('Demo package upload exceeds eight MiB.');
  const configPath = scopePath(input, origin);
  const before = JSON.parse(await readFile(configPath, 'utf8')) as DeviceConfig;
  if (before.schema !== 'dharma.demo-device/v1' || before.hqUrl !== origin
    || before.organizationId !== input.organizationId || before.repositoryId !== input.repositoryId
    || before.normalizedRepository !== input.normalizedRepository
    || before.installationId !== input.installationId || !UUID.test(before.deviceId)
    || !Number.isSafeInteger(before.nextSequence) || before.nextSequence < 1) {
    throw new Error('Demo device config does not match the requested repository.');
  }
  // A previous response may have been lost after the server consumed its sequence.
  await verifyDemoDevice(input, { ...deps, expectedAcceptedSequence: before.nextSequence });
  const config = JSON.parse(await readFile(configPath, 'utf8')) as DeviceConfig;
  if (!config.signedReady || !UUID.test(config.deviceId)) throw new Error('Demo device is not signed ready.');
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${input.organizationId}:${input.repositoryId}`,
    installationId: input.installationId, store: deps.store });
  if (identity.publicKeyEd25519 !== config.publicKeyEd25519) throw new Error('Demo device key mismatch.');
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(24).toString('base64url');
  const sequence = config.nextSequence;
  const payload = Buffer.from(JSON.stringify({
    bodyHash: `sha256:${createHash('sha256').update(rawBody).digest('hex')}`,
    deviceId: config.deviceId, messageId, method, nonce,
    organizationId: input.organizationId,
    pathname: `${url.pathname}${url.search}`, sequence, sessionId, timestamp,
  }));
  const headers: Record<string, string> = {
    'x-dharma-device-id': config.deviceId,
    'x-dharma-session-id': sessionId,
    'x-dharma-message-id': messageId,
    'x-dharma-timestamp': timestamp,
    'x-dharma-nonce': nonce,
    'x-dharma-sequence': String(sequence),
    'x-dharma-signature': sign(null, payload,
      { key: identity.privateJwk, format: 'jwk' }).toString('base64url'),
  };
  if (method === 'POST') headers['content-type'] = 'application/json';
  const response = await (deps.fetcher || fetch)(url, {
    method, headers, body: method === 'POST' ? rawBody : undefined,
  });
  // Authentication can reject before consuming a sequence. The signed status
  // reconciles both outcomes without persisting source bytes or guessing.
  await verifyDemoDevice(input, { ...deps, expectedAcceptedSequence: sequence });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiError(result, response.status);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || (result as Record<string, unknown>).ok !== true) {
    throw new Error('Demo package response is not a verified JSON receipt.');
  }
  return result as Record<string, unknown>;
}

function transport(input: DemoDeviceScope, deps: DemoPackageDependencies): RepositoryCandidateTransport {
  const standard = `/agent-fabric/repository-agents/${input.repositoryId}/package-candidates`;
  const target = `/api/demo/fabric/repositories/${input.repositoryId}/package-candidates`;
  const map = (route: string) => {
    if (route !== standard && !route.startsWith(`${standard}/`)) {
      throw new Error('Repository candidate route is outside this Demo binding.');
    }
    return `${target}${route.slice(standard.length)}`;
  };
  return {
    signedGet: route => signedJson(input, 'GET', map(route), undefined, deps),
    signedPost: (route, body) => signedJson(input, 'POST', map(route), body, deps),
  };
}

async function ensureDemoLocalKnowledge(input: { workspace: string; scope: DemoDeviceScope;
  workspaceId: string }) {
  const ownership = await assertRepositoryInstallerOwnership(input.workspace, input.scope.repositoryId);
  if (ownership === 'absent') {
    await mkdir(resolve(input.workspace, '.agents/skills'), { recursive: true, mode: 0o700 });
    await mkdir(resolve(input.workspace, '.agents/skills/dharma-agent-fabric'), { mode: 0o700 });
    await writeRepositoryInstallerFile(input.workspace,
      '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
      `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.scope.repositoryId })}\n`);
  }
  if (ownership !== 'signed') {
    await mkdir(resolve(input.workspace, '.agents/skills/dharma-agent-fabric/references'),
      { recursive: true, mode: 0o700 });
    const onboarding = await readFile(fileURLToPath(new URL('../AGENT_FABRIC_ONBOARDING.md', import.meta.url)), 'utf8');
    await writeRepositoryInstallerFile(input.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md',
      `---\nname: dharma-agent-fabric\ndescription: Shared repository knowledge and team coordination.\n---\n\n${onboarding}`);
    await writeRepositoryInstallerFile(input.workspace,
      '.agents/skills/dharma-agent-fabric/references/organization.md',
      `# Demo repository\n\nOrganization: ${input.scope.organizationId}\nRepository: ${input.scope.normalizedRepository}\n`);
    return initializeRepositoryKnowledge({ workspace: input.workspace,
      organizationId: input.scope.organizationId,
      repositoryAgentId: input.scope.repositoryId });
  }
  return null;
}

async function reconcileDemoInstallerMarker(input: { workspace: string; repositoryId: string;
  legacySpaceId: string }) {
  try { return await assertRepositoryInstallerOwnership(input.workspace, input.repositoryId); }
  catch (error) {
    if (input.repositoryId === input.legacySpaceId) throw error;
    const legacy = await assertRepositoryInstallerOwnership(input.workspace, input.legacySpaceId);
    if (legacy !== 'installer') throw error;
    await writeRepositoryInstallerFile(input.workspace,
      '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
      `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.repositoryId })}\n`);
    return assertRepositoryInstallerOwnership(input.workspace, input.repositoryId);
  }
}

function demoInstallPolicy(authorization: ReturnType<typeof validateRepositorySourceAuthorization>):
  Parameters<typeof installSkillBundle>[0]['policy'] {
  return { organizationId: authorization.organizationId,
    skills: { automaticInstall: authorization.policy.automaticValidatedPublication } };
}

function policyCoversPrior(prior: RepositorySourceAuthorization, current: RepositorySourceAuthorization) {
  const covers = (earlier: string[], later: string[]) => earlier.every(path => later.some(root =>
    root === '.' || root === path || path.startsWith(`${root}/`)));
  const old = prior.policy, next = current.policy;
  return current.revision > prior.revision && current.generationId !== prior.generationId
    && Date.parse(current.confirmedAt) >= Date.parse(prior.confirmedAt)
    && old.allowedContentClasses.every(value => next.allowedContentClasses.includes(value))
    && covers(old.approvedRepositoryPaths, next.approvedRepositoryPaths)
    && covers(old.approvedOutputFolders, next.approvedOutputFolders)
    && next.automaticValidatedPublication && next.maximumFileBytes >= old.maximumFileBytes
    && next.maximumSnapshotBytes >= old.maximumSnapshotBytes
    && next.maximumDailyUploadBytes >= old.maximumDailyUploadBytes
    && next.retentionDays >= old.retentionDays
    && (next.expiresAt === null || old.expiresAt !== null
      && Date.parse(next.expiresAt) >= Date.parse(old.expiresAt));
}

async function installActiveDemoPackage(input: {
  scope: DemoDeviceScope; workspaceId: string;
  provider: ProviderId; nativeSkillDirectory: string;
  authorization: ReturnType<typeof validateRepositorySourceAuthorization>;
}, deps: DemoPackageDependencies) {
  const { scope } = input;
  const root = `/api/demo/fabric/repositories/${scope.repositoryId}/packages`;
  const active = await signedJson(scope, 'GET', `${root}/active`, undefined, deps);
  if (active.organizationId !== scope.organizationId || active.repositoryId !== scope.repositoryId
    || active.repositoryPackageState !== 'published' || !active.package
    || typeof active.package !== 'object' || Array.isArray(active.package)) {
    return null;
  }
  const published = active.package as Record<string, unknown>;
  if (!UUID.test(String(published.releaseId || '')) || !published.envelope || !published.bundle
    || !published.index || typeof published.index !== 'object') {
    throw new Error('Active Demo package receipt is incomplete.');
  }
  const envelope = published.envelope as Record<string, unknown>;
  const descriptor = envelope.descriptor as Record<string, unknown>;
  if (!descriptor || descriptor.organizationId !== scope.organizationId
    || descriptor.repositoryBindingId !== scope.repositoryId
    || descriptor.releaseId !== published.releaseId) {
    throw new Error('Active Demo release does not match the current repository authorization.');
  }
  const trust = await loadDemoSigningTrust(scope);
  const bundle = published.bundle as SkillBundle;
  const { signature, ...unsignedEnvelope } = envelope;
  const now = Date.now();
  const signingKey = trust.keyset.keys.filter(key =>
    ['active', 'overlap'].includes(key.status)
    && Date.parse(key.notBefore) <= now && Date.parse(key.notAfter) > now)
    .map(key => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
      x: key.publicKeyEd25519 }, format: 'jwk' }))
    .find(key => {
      if (typeof signature !== 'string' || !verifyCanonicalObject(unsignedEnvelope, signature, key)) return false;
      try { verifySkillBundle(bundle, key); return true; }
      catch { return false; }
    });
  if (!signingKey) throw new Error('Demo release is not signed by a currently trusted organization key.');
  const releaseId = String(published.releaseId);
  if (descriptor.policyHash !== input.authorization.policyHash) {
    return { policyTransition: true as const, releaseId, policyHash: descriptor.policyHash };
  }
  const delivery = await receiveRepositoryPackageDelivery({
    envelope, bundle, serverPublicKey: signingKey,
    scope: { organizationId: scope.organizationId, repositoryBindingId: scope.repositoryId,
      repositoryAgentId: scope.repositoryId, deviceId: trust.deviceId,
      workspaceId: input.workspaceId, provider: input.provider },
    fetchIndex: async () => published.index,
    fetchChunk: async (fileIndex, chunkIndex) => {
      const response = await signedJson(scope, 'GET',
        `${root}/${releaseId}/chunks/${fileIndex}/${chunkIndex}`, undefined, deps);
      if (response.organizationId !== scope.organizationId || response.repositoryId !== scope.repositoryId
        || response.releaseId !== releaseId) throw new Error('Demo package chunk scope changed.');
      return response.chunk;
    },
  });
  const installerWorkspaceId = scope.repositoryId;
  const config = { hqUrl: normalizeHqUrl(scope.hqUrl), organizationId: scope.organizationId,
    deviceId: trust.deviceId };
  const anchorInput = { config, workspaceId: installerWorkspaceId,
    organizationAgentId: scope.repositoryId, provider: input.provider, store: deps.store };
  const prior = await loadActiveSkillAuthorizationAnchor(anchorInput);
  if (prior) {
    const priorBundle = JSON.parse(await readFile(resolve(input.nativeSkillDirectory,
      '.dharma-managed', 'workspaces', installerWorkspaceId, 'active', 'AUTHORIZATION.json'),
    'utf8')) as SkillBundle;
    const priorSigningKey = trust.keyset.keys.filter(key =>
      ['active', 'overlap'].includes(key.status)
      && Date.parse(key.notBefore) <= now && Date.parse(key.notAfter) > now)
      .map(key => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
        x: key.publicKeyEd25519 }, format: 'jwk' }))
      .find(key => {
        try { verifySkillBundle(priorBundle, key); return true; }
        catch { return false; }
      });
    if (!priorSigningKey) throw new Error('Active Demo package is not signed by a currently trusted key.');
    const priorAuthorization = await getActiveSkillBundleAuthorization({ nativeSkillDirectory: input.nativeSkillDirectory,
      workspaceId: installerWorkspaceId, provider: input.provider,
      organizationId: scope.organizationId, organizationAgentId: scope.repositoryId,
      deviceId: trust.deviceId, serverPublicKey: priorSigningKey,
      devicePublicKey: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
        x: (JSON.parse(await readFile(scopePath(scope, config.hqUrl), 'utf8')) as DeviceConfig).publicKeyEd25519 }, format: 'jwk' }),
      expectedReceiptHash: prior.receiptHash });
    if (!priorAuthorization || priorAuthorization.bundleId !== prior.bundleId) {
      throw new Error('Protected Demo package receipt does not match the active installation.');
    }
    if (prior.bundleId === bundle.bundleId) return { releaseId, bundleId: bundle.bundleId,
      receiptHash: prior.receiptHash, alreadyInstalled: true };
  } else {
    const pointer = resolve(input.nativeSkillDirectory, '.dharma-managed', 'workspaces',
      installerWorkspaceId, 'ACTIVE_BUNDLE');
    try { await readFile(pointer); throw new Error('Existing Demo package has no protected receipt anchor.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const currentScope = await signedJson(scope, 'GET',
    `/api/demo/fabric/repositories/${scope.repositoryId}/package-scope`, undefined, deps);
  const currentAuthorization = validateRepositorySourceAuthorization(currentScope.sourceAuthorization,
    { organizationId: scope.organizationId, workspaceId: input.workspaceId,
      repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId }, new Date());
  const currentActive = await signedJson(scope, 'GET', `${root}/active`, undefined, deps);
  if (currentAuthorization.policyHash !== input.authorization.policyHash
    || currentActive.repositoryPackageState !== 'published'
    || (currentActive.package as Record<string, unknown> | null)?.releaseId !== releaseId) {
    throw new Error('Demo policy or active release changed before installation.');
  }
  delivery.assertCurrent();
  const parent = resolve(scope.stateRoot, 'demo-package-sources');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const sourceRoot = await mkdtemp(resolve(parent, 'attempt-'));
  try {
    for (const file of delivery.files) {
      delivery.assertCurrent();
      const destination = resolve(sourceRoot, file.path);
      const within = relative(sourceRoot, destination);
      if (within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) {
        throw new Error('Demo package file escapes its staging directory.');
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    delivery.assertCurrent();
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl,
      organizationId: `${scope.organizationId}:${scope.repositoryId}`,
      installationId: scope.installationId, store: deps.store });
    const receipt = await installSkillBundle({ bundle: delivery.bundle, sourceDirectory: sourceRoot,
      nativeSkillDirectory: input.nativeSkillDirectory, policy: demoInstallPolicy(currentAuthorization),
      serverPublicKey: signingKey, devicePrivateKey: createPrivateKey({ key: identity.privateJwk, format: 'jwk' }),
      deviceId: trust.deviceId, organizationAgentId: scope.repositoryId,
      workspaceId: installerWorkspaceId, provider: input.provider });
    if (receipt.status !== 'active') throw new Error(`Demo signed package installation ${receipt.status}.`);
    try {
      await saveActiveSkillAuthorizationAnchor({ ...anchorInput, bundleId: receipt.bundleId,
        receiptHash: receipt.receiptHash, activatedAt: receipt.completedAt,
        expiresAt: delivery.bundle.expiresAt ?? null });
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      try { await rollbackUnconfirmedSkillBundle({ nativeSkillDirectory: input.nativeSkillDirectory,
        workspaceId: installerWorkspaceId, receipt }); }
      catch (failure) { recoveryErrors.push(failure); }
      try {
        if (prior) await saveActiveSkillAuthorizationAnchor({ ...anchorInput,
          bundleId: prior.bundleId, receiptHash: prior.receiptHash,
          activatedAt: prior.activatedAt, expiresAt: prior.expiresAt });
        else await deleteActiveSkillAuthorizationAnchor(anchorInput);
      } catch (failure) { recoveryErrors.push(failure); }
      if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors],
        'Demo package anchor persistence failed and local recovery was incomplete.');
      throw error;
    }
    return { releaseId, bundleId: receipt.bundleId, receiptHash: receipt.receiptHash,
      alreadyInstalled: false };
  } finally { await rm(sourceRoot, { recursive: true, force: true }); }
}

async function acknowledgeDemoInstallation(input: { scope: DemoDeviceScope;
  nativeSkillDirectory: string; installed: { releaseId: string; bundleId: string;
    receiptHash: string } }, deps: DemoPackageDependencies) {
  const { scope, installed } = input;
  const path = resolve(input.nativeSkillDirectory, '.dharma-managed', 'workspaces',
    scope.repositoryId, 'active', 'INSTALL_RECEIPT.json');
  const bytes = await readFile(path);
  if (bytes.length > 131_072) throw new Error('Demo installation receipt exceeds its limit.');
  const receipt = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (receipt.schema !== 'dharma.install-receipt/v1'
    || receipt.workspaceId !== scope.repositoryId
    || receipt.bundleId !== installed.bundleId
    || receipt.receiptHash !== installed.receiptHash
    || receipt.status !== 'active') {
    throw new Error('Local Demo installation receipt does not match the protected release.');
  }
  const result = await signedJson(scope, 'POST',
    `/api/demo/fabric/repositories/${scope.repositoryId}/packages/${installed.releaseId}/install-receipts`,
    { receipt }, deps);
  if (result.organizationId !== scope.organizationId || result.repositoryId !== scope.repositoryId
    || result.releaseId !== installed.releaseId || result.bundleId !== installed.bundleId
    || result.receiptHash !== installed.receiptHash) {
    throw new Error('Demo package acknowledgement does not match the active installation.');
  }
  return { receiptHash: installed.receiptHash, duplicate: result.duplicate === true };
}

async function syncPublishedDemoSource(input: {
  scope: DemoDeviceScope; workspace: string; workspaceId: string;
  publishedSourceFingerprint: string;
  activeReleaseId: string;
  authorization: ReturnType<typeof validateRepositorySourceAuthorization>;
  candidateTransport: RepositoryCandidateTransport;
  outboxRoot: string;
  priorPolicyHash?: string;
  publishedAuthorization?: ReturnType<typeof validateRepositorySourceAuthorization>;
}, deps: DemoPackageDependencies) {
  const { scope } = input;
  const baselineScope = { organizationId: scope.organizationId, repositoryId: scope.repositoryId,
    workspaceId: input.workspaceId, policyHash: input.authorization.policyHash };
  const snapshot = await inventoryRepositoryPackage({ workspace: input.workspace,
    organizationId: scope.organizationId, workspaceId: input.workspaceId,
    repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId,
    sourceAuthorization: input.authorization });
  const fingerprint = snapshot.manifest.sourceFingerprint;
  if (!fingerprint) throw new Error('Demo source inventory has no fingerprint.');
  let baseline = await readDemoSourceBaseline(scope.stateRoot, baselineScope,
    { priorPolicyHash: input.priorPolicyHash });
  let history = await readDemoSourceHistory(scope.stateRoot, baselineScope, input.priorPolicyHash);
  if (!history) {
    await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot, candidateOnly: true });
    history = { schema: 'dharma.demo-source-history/v1', ...baselineScope,
      localSnapshotHash: snapshot.manifest.snapshotHash, pending: null };
    await writeDemoSourceHistory(scope.stateRoot, history);
    // Legacy fingerprints do not prove this client ever observed another client's files.
    if (!input.priorPolicyHash) baseline = null;
  }
  let previousLocal = await readRepositoryPackageSnapshot(input.workspace, history.localSnapshotHash);
  if (previousLocal.manifest.organizationId !== scope.organizationId
    || previousLocal.manifest.workspaceId !== input.workspaceId
    || previousLocal.manifest.sourceAuthorization?.repositoryBindingId !== scope.repositoryId
    || previousLocal.manifest.sourceAuthorization?.repositoryAgentId !== scope.repositoryId) {
    throw new Error('Demo source history has a different repository scope.');
  }
  if (previousLocal.manifest.sourceAuthorization?.generationId !== input.authorization.generationId) {
    if (!input.priorPolicyHash
      || previousLocal.manifest.sourceAuthorization?.policyHash !== input.priorPolicyHash) {
      throw new Error('Demo source history has a different authority.');
    }
    previousLocal = rebuildRepositoryPackageSnapshot(snapshot, {
      files: previousLocal.manifest.files, skills: previousLocal.manifest.skills, blobs: previousLocal.blobs });
    await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot: previousLocal, candidateOnly: true });
    history = { ...history, ...baselineScope, localSnapshotHash: previousLocal.manifest.snapshotHash };
    await writeDemoSourceHistory(scope.stateRoot, history);
  }
  if (history.pending) {
    const candidate = await pollRepositoryCandidate({ transport: input.candidateTransport,
      outboxRoot: input.outboxRoot, scope: { organizationId: scope.organizationId,
        workspaceId: input.workspaceId, repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId } });
    if (candidate && candidate.snapshotHash !== history.pending.snapshotHash) {
      throw new Error('Demo source receipt does not match its pending snapshot.');
    }
    if (candidate?.state === 'published') {
      if (!candidate.releaseId || candidate.releaseId === input.activeReleaseId
        && history.pending.sourceFingerprint !== input.publishedSourceFingerprint) {
        throw new Error('Demo source completion does not match its published parent.');
      }
      previousLocal = await readRepositoryPackageSnapshot(input.workspace, history.pending.localSnapshotHash);
      history = { ...history, ...baselineScope, localSnapshotHash: history.pending.localSnapshotHash, pending: null };
      await writeDemoSourceHistory(scope.stateRoot, history);
      baseline = { schema: 'dharma.demo-source-baseline/v1', ...baselineScope,
        localFingerprint: previousLocal.manifest.sourceFingerprint!,
        publishedFingerprint: input.publishedSourceFingerprint, pendingFingerprint: null, firstObservedAt: null };
      await writeDemoSourceBaseline(scope.stateRoot, baseline);
    } else if (candidate && candidate.state !== 'blocked') {
      return { state: 'submitted', fingerprint, candidate };
    } else if (candidate?.state === 'blocked') {
      history = { ...history, pending: null };
      await writeDemoSourceHistory(scope.stateRoot, history);
    } else {
      const pending = await readRepositoryPackageSnapshot(input.workspace, history.pending.snapshotHash);
      const receipt = await synchronizeRepositoryCandidate({ transport: input.candidateTransport,
        outboxRoot: input.outboxRoot, scope: { organizationId: scope.organizationId,
          workspaceId: input.workspaceId, repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId },
        snapshot: { ...pending, capturedAt: history.pending.capturedAt }, initialRepository: false,
        expectedLatestSourceFingerprint: baseline?.publishedFingerprint ?? input.publishedSourceFingerprint });
      return { state: receipt.state === 'blocked' ? 'blocked' : 'submitted', fingerprint, candidate: receipt };
    }
  }
  if (baseline && baseline.policyHash === baselineScope.policyHash
    && baseline.publishedFingerprint !== input.publishedSourceFingerprint) {
    baseline = { ...baseline, publishedFingerprint: input.publishedSourceFingerprint };
  }
  const scheduled = input.priorPolicyHash && (!baseline || baseline.policyHash !== baselineScope.policyHash)
    ? { schema: 'dharma.demo-source-baseline/v1' as const, ...baselineScope,
        localFingerprint: input.publishedSourceFingerprint,
        publishedFingerprint: input.publishedSourceFingerprint,
        pendingFingerprint: null, firstObservedAt: null }
    : baseline;
  const observed = observeDemoSource({ baseline: scheduled, scope: baselineScope,
    localFingerprint: fingerprint, publishedFingerprint: input.publishedSourceFingerprint,
    now: (deps.now || Date.now)() });
  if (observed.baseline !== baseline) await writeDemoSourceBaseline(scope.stateRoot, observed.baseline);
  if (observed.state !== 'stable') return { state: observed.state, fingerprint, candidate: null };
  const fresh = await signedJson(scope, 'GET',
    `/api/demo/fabric/repositories/${scope.repositoryId}/package-scope`, undefined, deps);
  if (fresh.activeReleaseId !== input.activeReleaseId
    || fresh.publishedSourceFingerprint !== input.publishedSourceFingerprint
    || fresh.sourceAuthorization === null) {
    throw new Error('Demo source parent or authorization changed before submission.');
  }
  const current = validateRepositorySourceAuthorization(fresh.sourceAuthorization,
    { organizationId: scope.organizationId, workspaceId: input.workspaceId,
      repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId }, new Date());
  if (current.policyHash !== input.authorization.policyHash) {
    throw new Error('Demo source policy changed before submission.');
  }
  const prefix = `/agent-fabric/repository-agents/${scope.repositoryId}/source-inventory`;
  let sourceRequests: Promise<void> = Promise.resolve();
  const published = await fetchPublishedRepositorySource({
    transport: { signedGet: route => {
      if (!route.startsWith(`${prefix}?`) && !route.startsWith(`${prefix}/`)) {
        throw new Error('Demo source inventory route is outside this binding.');
      }
      // Demo signatures use a single monotonic device sequence, unlike the SDK transport.
      const pending = sourceRequests.then(() => signedJson(scope, 'GET',
        `/api/demo/fabric/repositories/${scope.repositoryId}/source-inventory${route.slice(prefix.length)}`, undefined, deps));
      sourceRequests = pending.then(() => undefined, () => undefined);
      return pending;
    } },
    scope: { organizationId: scope.organizationId, workspaceId: input.workspaceId,
      repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId },
    authorization: current, publishedAuthorization: input.publishedAuthorization,
    local: snapshot });
  if (!published || published.sourceFingerprint !== input.publishedSourceFingerprint) {
    throw new Error('Demo published source parent changed during reconciliation.');
  }
  const reconciled = reconcileRepositorySourceSnapshot({ local: snapshot, previousLocal, published });
  const rechecked = await signedJson(scope, 'GET',
    `/api/demo/fabric/repositories/${scope.repositoryId}/package-scope`, undefined, deps);
  if (rechecked.activeReleaseId !== input.activeReleaseId
    || rechecked.publishedSourceFingerprint !== published.sourceFingerprint
    || canonicalize(rechecked.sourceAuthorization) !== canonicalize(current)) {
    throw new Error('Demo source parent or policy changed during reconciliation.');
  }
  await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot, candidateOnly: true });
  if (reconciled.manifest.sourceFingerprint === published.sourceFingerprint) {
    await writeDemoSourceHistory(scope.stateRoot, { ...history, ...baselineScope,
      localSnapshotHash: snapshot.manifest.snapshotHash, pending: null });
    await writeDemoSourceBaseline(scope.stateRoot, { ...observed.baseline,
      localFingerprint: fingerprint, pendingFingerprint: null, firstObservedAt: null });
    return { state: 'source_already_published', fingerprint, candidate: null };
  }
  await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot: reconciled, candidateOnly: true });
  await writeDemoSourceHistory(scope.stateRoot, { ...history, ...baselineScope,
    pending: { localSnapshotHash: snapshot.manifest.snapshotHash,
      snapshotHash: reconciled.manifest.snapshotHash, sourceFingerprint: reconciled.manifest.sourceFingerprint!,
      capturedAt: reconciled.capturedAt } });
  const candidate = await synchronizeRepositoryCandidate({ transport: input.candidateTransport,
    outboxRoot: input.outboxRoot,
    scope: { organizationId: scope.organizationId, workspaceId: input.workspaceId,
      repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId },
    snapshot: reconciled, initialRepository: false,
    expectedLatestSourceFingerprint: input.publishedSourceFingerprint });
  return { state: candidate.state === 'blocked' ? 'blocked' : 'submitted', fingerprint, candidate };
}

export async function demoRepositoryPackage(input: {
  scope: DemoDeviceScope;
  workspace: string;
  statusOnly?: boolean;
  provider?: ProviderId;
  nativeSkillDirectory?: string;
}, deps: DemoPackageDependencies = {}) {
  const { scope } = input;
  const root = `/api/demo/fabric/repositories/${scope.repositoryId}`;
  const view = await signedJson(scope, 'GET', `${root}/package-scope`, undefined, deps);
  if (view.organizationId !== scope.organizationId || view.repositoryId !== scope.repositoryId
    || view.repositoryAgentId !== scope.repositoryId
    || view.normalizedRepository !== scope.normalizedRepository
    || typeof view.workspaceId !== 'string' || !UUID.test(view.workspaceId)) {
    throw new Error('Demo package scope does not match this enrolled repository.');
  }
  if (view.repositoryPackageState !== 'published' && view.repositoryPackageState !== 'not_connected') {
    throw new Error('Demo repository package state is invalid.');
  }
  const candidateScope = { organizationId: scope.organizationId, workspaceId: view.workspaceId,
    repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId };
  const candidateTransport = transport(scope, deps);
  const outboxRoot = resolve(scope.stateRoot, 'demo-repository-candidates', scope.organizationId,
    scope.repositoryId);
  if (input.statusOnly) {
    const candidate = await pollRepositoryCandidate({ transport: candidateTransport,
      outboxRoot, scope: candidateScope });
    return { ok: true, stage: 'demo_repository_package_status', repositoryId: scope.repositoryId,
      repositoryPackageState: view.repositoryPackageState, candidate, ready: false,
      activationState: view.repositoryPackageState === 'published'
        ? 'signed_delivery_pending' : 'candidate_pending' };
  }
  if (!view.sourceAuthorization) throw new Error('Demo repository has no active source authorization.');
  const sourceAuthorization = validateRepositorySourceAuthorization(view.sourceAuthorization,
    candidateScope, new Date());
  const ownership = await reconcileDemoInstallerMarker({ workspace: input.workspace,
    repositoryId: scope.repositoryId, legacySpaceId: view.workspaceId });
  if (view.repositoryPackageState === 'published') {
    if (typeof view.publishedSourceFingerprint !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(view.publishedSourceFingerprint)
      || typeof view.activeReleaseId !== 'string' || !UUID.test(view.activeReleaseId)) {
      throw new Error('Published Demo package has no verified source parent.');
    }
    const nativeSkillDirectory = input.nativeSkillDirectory ?? resolve(input.workspace, '.agents/skills');
    const installed = await installActiveDemoPackage({ scope,
      workspaceId: view.workspaceId, provider: input.provider ?? 'codex',
      nativeSkillDirectory,
      authorization: sourceAuthorization }, deps);
    if (installed && 'policyTransition' in installed) {
      if (installed.releaseId !== view.activeReleaseId) {
        throw new Error('Demo active release changed during policy transition.');
      }
      if (!view.activeReleaseSourceAuthorization) {
        throw new Error('Demo active release policy is unavailable for transition.');
      }
      const previous = validateRepositorySourceAuthorization(view.activeReleaseSourceAuthorization,
        candidateScope);
      if (previous.policyHash !== installed.policyHash) {
        throw new Error('Demo active release policy hash does not match its signed descriptor.');
      }
      if (!policyCoversPrior(previous, sourceAuthorization)) {
        throw new Error('Demo current source policy narrows the active release policy; suspend or replace the release before synchronization.');
      }
      if (ownership !== 'signed') return { ok: true,
        stage: 'demo_repository_package_policy_transition', repositoryId: scope.repositoryId,
        repositoryPackageState: 'published', candidate: null, ready: false,
        activationState: 'signed_delivery_pending' };
      const sourceSync = await syncPublishedDemoSource({ scope, workspace: input.workspace,
        workspaceId: view.workspaceId, authorization: sourceAuthorization,
        publishedSourceFingerprint: view.publishedSourceFingerprint,
        activeReleaseId: view.activeReleaseId, candidateTransport, outboxRoot,
        priorPolicyHash: previous.policyHash, publishedAuthorization: previous }, deps);
      return { ok: true, stage: 'demo_repository_package_policy_transition',
        repositoryId: scope.repositoryId, repositoryPackageState: 'published',
        candidate: null, sourceSync, ready: false, activationState: 'candidate_pending' };
    }
    if (installed) {
      const acknowledgement = await acknowledgeDemoInstallation({ scope, nativeSkillDirectory,
        installed }, deps);
      const sourceSync = await syncPublishedDemoSource({ scope, workspace: input.workspace,
        workspaceId: view.workspaceId, authorization: sourceAuthorization,
        publishedSourceFingerprint: view.publishedSourceFingerprint,
        activeReleaseId: view.activeReleaseId, candidateTransport, outboxRoot }, deps);
      return { ok: true, stage: 'demo_repository_package_installed',
        repositoryId: scope.repositoryId, repositoryPackageState: 'published',
        candidate: null, installed, acknowledgement, sourceSync,
        ready: false, activationState: 'signed_package_active' };
    }
    return { ok: true, stage: 'demo_repository_package_delivery_pending',
      repositoryId: scope.repositoryId, repositoryPackageState: 'published',
      candidate: null, ready: false, activationState: 'signed_delivery_pending' };
  }
  const knowledge = await ensureDemoLocalKnowledge({ workspace: input.workspace,
    scope, workspaceId: view.workspaceId });
  const snapshot = await inventoryRepositoryPackage({ workspace: input.workspace,
    organizationId: scope.organizationId, workspaceId: view.workspaceId,
    repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId,
    sourceAuthorization });
  await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot, candidateOnly: true });
  const candidate = await synchronizeRepositoryCandidate({ transport: candidateTransport,
    outboxRoot, scope: candidateScope, snapshot,
    initialRepository: true });
  if (candidate.state !== 'blocked' && snapshot.manifest.sourceFingerprint) {
    await writeDemoSourceBaseline(scope.stateRoot, {
      schema: 'dharma.demo-source-baseline/v1',
      organizationId: scope.organizationId, repositoryId: scope.repositoryId,
      workspaceId: view.workspaceId, policyHash: sourceAuthorization.policyHash,
      localFingerprint: snapshot.manifest.sourceFingerprint,
      publishedFingerprint: null, pendingFingerprint: null, firstObservedAt: null,
    });
  }
  return { ok: true, stage: 'demo_repository_package_candidate', repositoryId: scope.repositoryId,
    repositoryPackageState: view.repositoryPackageState, candidate,
    firstLearning: knowledge ? { disposition: knowledge.disposition,
      knowledgeBaseId: knowledge.catalog.knowledgeBaseId } : { disposition: 'signed_release_reused' },
    ready: false, activationState: candidate.state === 'published'
      ? 'signed_delivery_pending' : 'candidate_pending' };
}
