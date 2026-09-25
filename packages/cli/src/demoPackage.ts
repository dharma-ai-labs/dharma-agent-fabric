import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { scopePath, verifyDemoDevice, type DemoDeviceScope } from './demoEnrollment.js';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';
import { assertRepositoryInstallerOwnership, writeRepositoryInstallerFile } from './repositoryInstallerFiles.js';
import { pollRepositoryCandidate, synchronizeRepositoryCandidate,
  type RepositoryCandidateTransport } from './repositoryCandidateSync.js';
import { validateRepositorySourceAuthorization } from './repositorySourceAuthorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DeviceConfig = {
  schema: string; hqUrl: string; organizationId: string; repositoryId: string;
  normalizedRepository: string; installationId: string; deviceId: string;
  publicKeyEd25519: string; signedReady: boolean; nextSequence: number;
};

export interface DemoPackageDependencies { store?: SecureSecretStore; fetcher?: typeof fetch }

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
  const ownership = await assertRepositoryInstallerOwnership(input.workspace, input.workspaceId);
  if (ownership === 'absent') {
    await mkdir(resolve(input.workspace, '.agents/skills'), { recursive: true, mode: 0o700 });
    await mkdir(resolve(input.workspace, '.agents/skills/dharma-agent-fabric'), { mode: 0o700 });
    await writeRepositoryInstallerFile(input.workspace,
      '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
      `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId })}\n`);
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

export async function demoRepositoryPackage(input: {
  scope: DemoDeviceScope;
  workspace: string;
  statusOnly?: boolean;
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
  const ownership = await assertRepositoryInstallerOwnership(input.workspace, view.workspaceId);
  if (view.repositoryPackageState === 'published' && ownership !== 'signed') {
    return { ok: true, stage: 'demo_repository_package_delivery_pending',
      repositoryId: scope.repositoryId, repositoryPackageState: view.repositoryPackageState,
      candidate: null, ready: false, activationState: 'signed_delivery_pending' };
  }
  if (!view.sourceAuthorization) throw new Error('Demo repository has no active source authorization.');
  const sourceAuthorization = validateRepositorySourceAuthorization(view.sourceAuthorization,
    candidateScope, new Date());
  const knowledge = await ensureDemoLocalKnowledge({ workspace: input.workspace,
    scope, workspaceId: view.workspaceId });
  const snapshot = await inventoryRepositoryPackage({ workspace: input.workspace,
    organizationId: scope.organizationId, workspaceId: view.workspaceId,
    repositoryBindingId: scope.repositoryId, repositoryAgentId: scope.repositoryId,
    sourceAuthorization });
  const candidate = await synchronizeRepositoryCandidate({ transport: candidateTransport,
    outboxRoot, scope: candidateScope, snapshot,
    initialRepository: view.repositoryPackageState !== 'published' });
  return { ok: true, stage: 'demo_repository_package_candidate', repositoryId: scope.repositoryId,
    repositoryPackageState: view.repositoryPackageState, candidate,
    firstLearning: knowledge ? { disposition: knowledge.disposition,
      knowledgeBaseId: knowledge.catalog.knowledgeBaseId } : { disposition: 'signed_release_reused' },
    ready: false, activationState: candidate.state === 'published'
      ? 'signed_delivery_pending' : 'candidate_pending' };
}
