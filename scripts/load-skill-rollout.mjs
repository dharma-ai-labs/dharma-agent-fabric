#!/usr/bin/env node

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { canonicalize, sha256, signCanonicalObject, verifyCanonicalObject } from '../packages/contracts/dist/index.js';
import { calculateBundleHash, contentHash, installSkillBundle } from '../packages/skill-manager/dist/index.js';

const devices = positiveInteger(process.env.AGENT_FABRIC_ROLLOUT_DEVICES, 10_000);
const concurrency = positiveInteger(process.env.AGENT_FABRIC_ROLLOUT_CONCURRENCY, 64);

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received ${value}.`);
  return parsed;
}

const root = await mkdtemp(resolve(tmpdir(), 'dharma-rollout-load-'));
const sourceRoot = resolve(root, 'source');
const sourceSkill = resolve(sourceRoot, 'skill');
await mkdir(sourceSkill, { recursive: true });
await writeFile(resolve(sourceSkill, 'SKILL.md'), '# Evidence boundary\nRefuse unsupported claims and request the missing artifact.\n');

const server = generateKeyPairSync('ed25519');
const bundleId = randomUUID();
const bundleBase = {
  schema: 'dharma.skill-bundle/v1',
  bundleId,
  organizationId: 'org_rollout_load_proof',
  version: '1.0.0',
  operation: 'install',
  skills: [{
    skillId: 'dharma-evidence-boundary',
    version: '1.0.0',
    repository: 'https://github.com/dharma-ai-labs/rollout-load-proof.git',
    commit: 'load-proof',
    contentHash: await contentHash(sourceSkill),
    path: 'skill',
  }],
  riskClass: 'R2',
  targetSelectors: { providers: ['codex', 'claude'] },
  activationPolicy: 'next_session',
  rollbackBundleId: null,
  evaluationReceiptId: 'eval:rollout-load-proof',
  createdAt: new Date().toISOString(),
  expiresAt: null,
};
const bundleHash = calculateBundleHash(bundleBase);
const bundle = { ...bundleBase, bundleHash, signature: signCanonicalObject({ ...bundleBase, bundleHash }, server.privateKey) };
const policy = {
  schema: 'dharma.organization-policy/v1',
  organizationId: bundle.organizationId,
  revision: 'load-proof',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [],
    maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1,
  },
  tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: [], requireLocalConfirmationFor: [], allowedCommands: {} },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
  retention: {},
  budgets: {},
};

let nextDevice = 0;
let activeReceipts = 0;
let verifiedReceipts = 0;
let activeMarkers = 0;
const installationIds = new Set();
const startedAt = Date.now();

async function installNext() {
  while (true) {
    const index = nextDevice;
    nextDevice += 1;
    if (index >= devices) return;
    const device = generateKeyPairSync('ed25519');
    const nativeSkillDirectory = resolve(root, 'devices', String(index), 'skills');
    const receipt = await installSkillBundle({
      bundle,
      sourceDirectory: sourceRoot,
      nativeSkillDirectory,
      policy,
      serverPublicKey: server.publicKey,
      devicePrivateKey: device.privateKey,
      deviceId: randomUUID(),
      workspaceId: randomUUID(),
      provider: index % 2 === 0 ? 'codex' : 'claude',
    });
    if (receipt.status === 'active') activeReceipts += 1;
    installationIds.add(receipt.installationId);
    const { signature, ...signedReceipt } = receipt;
    const { receiptHash, ...hashInput } = signedReceipt;
    if (receiptHash === sha256(canonicalize(hashInput))
      && verifyCanonicalObject(signedReceipt, signature, device.publicKey)) verifiedReceipts += 1;
    if ((await readFile(resolve(nativeSkillDirectory, '.dharma-managed', 'ACTIVE_BUNDLE'), 'utf8')).trim() === bundleId) {
      activeMarkers += 1;
    }
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, devices) }, () => installNext()));
  const ok = activeReceipts === devices
    && verifiedReceipts === devices
    && activeMarkers === devices
    && installationIds.size === devices;
  process.stdout.write(`${JSON.stringify({
    ok,
    devices,
    concurrency,
    bundleId,
    bundleHash,
    activeReceipts,
    verifiedReceipts,
    activeMarkers,
    uniqueInstallationIds: installationIds.size,
    elapsedMs: Date.now() - startedAt,
    temporaryRootsDeleted: true,
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
