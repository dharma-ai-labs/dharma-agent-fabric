import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import * as manager from './index.js';

const ROOT = '.agents/skills/dharma-agent-fabric';
type ReadInput = Parameters<typeof manager.getActiveSkillBundleAuthorization>[0];
type Observation = { catalogBytes: Buffer; manifestBytes: Buffer; authorization: manager.ActiveSkillBundleAuthorization } | null;
async function observe(input: ReadInput): Promise<Observation> {
  const reader = (manager as unknown as { readVerifiedRepositoryKnowledge?: (scope: ReadInput) => Promise<Observation> }).readVerifiedRepositoryKnowledge;
  assert.equal(typeof reader, 'function', 'Public verified repository knowledge reader is required.');
  return reader!(input);
}
async function fixture(t: TestContext, ordinary = false, extras: Record<string, string> = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-managed-knowledge-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = resolve(home, 'source', ROOT), native = resolve(home, 'native');
  await mkdir(resolve(source, 'knowledge'), { recursive: true });
  const catalogBytes = Buffer.from('{"synthetic":"catalog bytes are opaque at this boundary"}\n');
  const manifestBytes = Buffer.from('{"synthetic":"manifest bytes are opaque at this boundary"}\n');
  await writeFile(resolve(source, 'SKILL.md'), '# Synthetic repository package\n');
  await writeFile(resolve(source, 'knowledge/CATALOG.json'), catalogBytes);
  await writeFile(resolve(source, 'MANIFEST.json'), manifestBytes);
  for (const [name, content] of Object.entries(extras)) {
    await mkdir(dirname(resolve(source, name)), { recursive: true });
    await writeFile(resolve(source, name), content);
  }
  const server = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID(), workspaceId = randomUUID(), organizationAgentId = randomUUID();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const unsigned = { schema: 'dharma.skill-bundle/v2' as const, bundleId: randomUUID(), organizationId: 'org_verified_reader',
    version: '1', operation: 'install' as const,
    skills: [{ skillId: 'dharma-agent-fabric', version: '1', repository: 'https://github.com/synthetic/control.git',
      commit: 'a'.repeat(40), path: ordinary ? ROOT.replace('dharma-agent-fabric', 'ordinary') : ROOT, contentHash: await manager.contentHash(source) }],
    riskClass: 'R2' as const, targetSelectors: { organizationAgentIds: [organizationAgentId], deviceIds: [deviceId], workspaceIds: [workspaceId], providers: ['codex' as const] },
    activationPolicy: 'next_session' as const, rollbackBundleId: null, evaluationReceiptId: 'synthetic-not-production-evaluation',
    createdAt: new Date().toISOString(), expiresAt };
  if (ordinary) {
    await mkdir(resolve(home, 'source', '.agents/skills/ordinary'), { recursive: true });
    for (const name of ['SKILL.md', 'MANIFEST.json']) await writeFile(resolve(home, 'source', '.agents/skills/ordinary', name), await readFile(resolve(source, name)));
    unsigned.skills[0]!.contentHash = await manager.contentHash(resolve(home, 'source', '.agents/skills/ordinary'));
  }
  const bundleHash = manager.calculateBundleHash(unsigned);
  const bundle = { ...unsigned, bundleHash, signature: signCanonicalObject({ ...unsigned, bundleHash }, server.privateKey) };
  const policy = { organizationId: unsigned.organizationId, skills: { automaticInstall: true } } as OrganizationPolicy;
  const receipt = await manager.installSkillBundle({ bundle, sourceDirectory: resolve(home, 'source'), nativeSkillDirectory: native,
    policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex' });
  assert.equal(receipt.status, 'active');
  const input: ReadInput = { nativeSkillDirectory: native, workspaceId, organizationId: unsigned.organizationId,
    organizationAgentId, deviceId, provider: 'codex', serverPublicKey: server.publicKey, devicePublicKey: device.publicKey, expectedReceiptHash: receipt.receiptHash };
  const active = resolve(native, '.dharma-managed/workspaces', workspaceId, 'active');
  return { home, native, source, active, bundle, input, catalogBytes, manifestBytes };
}

test('verified reader returns exact protected release bytes, not mutated global native copies', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.native, 'dharma-agent-fabric/knowledge/CATALOG.json'), 'Unapproved native edit');
  const result = await observe(f.input);
  assert.ok(result);
  assert.deepEqual(result.catalogBytes, f.catalogBytes);
  assert.deepEqual(result.manifestBytes, f.manifestBytes);
  assert.equal(result.authorization.bundleId, f.bundle.bundleId);
  assert.equal(result.authorization.bundleHash, f.bundle.bundleHash);
});

for (const field of ['organizationId', 'organizationAgentId', 'deviceId', 'provider', 'expectedReceiptHash'] as const) {
  test(`verified reader rejects foreign ${field}`, async t => {
    const f = await fixture(t);
    const input = { ...f.input, [field]: field === 'provider' ? 'claude' : field === 'expectedReceiptHash' ? `sha256:${'0'.repeat(64)}` : 'foreign' } as ReadInput;
    await assert.rejects(observe(input), /scope|authorized|receipt|organization|device|provider/i);
  });
}

test('verified reader refuses expired trust instead of using replacement-poll authority', async t => {
  const f = await fixture(t);
  await assert.rejects(observe({ ...f.input, now: new Date(Date.parse(f.bundle.expiresAt!) + 1) }), /expired/);
});

for (const path of ['knowledge/CATALOG.json', 'MANIFEST.json', 'SKILL.md'] as const) {
  test(`verified reader rejects protected release tampering at ${path}`, async t => {
    const f = await fixture(t);
    await writeFile(resolve(f.active, 'dharma-agent-fabric', path), 'Edited protected content');
    await assert.rejects(observe(f.input), /hash|integrity|release/);
  });
}

test('verified reader rejects symlinked protected files without following their content', async t => {
  const f = await fixture(t), path = resolve(f.active, 'dharma-agent-fabric/knowledge/CATALOG.json');
  await unlink(path); await symlink(resolve(f.source, 'knowledge/CATALOG.json'), path);
  await assert.rejects(observe(f.input), /symlink/);
});

test('verified reader rejects oversized protected files before attempting tree collection', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.active, 'dharma-agent-fabric/knowledge/CATALOG.json'), Buffer.alloc(262145, 'x'));
  await assert.rejects(observe(f.input), /limit/);
});

test('ordinary signed skills and absent installations do not fabricate repository knowledge', async t => {
  const f = await fixture(t, true);
  assert.equal(await observe(f.input), null);
  assert.equal(await observe({ ...f.input, nativeSkillDirectory: resolve(f.home, 'absent') }), null);
});

test('verified read preserves pointer and financial-independent installation state', async t => {
  const f = await fixture(t), pointer = resolve(f.active, '..', 'ACTIVE_BUNDLE');
  const before = await readFile(pointer);
  const authBefore = await readFile(resolve(f.active, 'AUTHORIZATION.json'));
  const result = await observe(f.input); assert.ok(result);
  assert.deepEqual(await readFile(pointer), before);
  assert.deepEqual(await readFile(resolve(f.active, 'AUTHORIZATION.json')), authBefore);
  assert.equal(createHash('sha256').update(result.catalogBytes).digest('hex'), createHash('sha256').update(f.catalogBytes).digest('hex'));
});

test('verified reader preserves installer hash ordering for Unicode names and empty companions', async t => {
  const f = await fixture(t, false, { 'references/\u03a9.txt': 'Omega', 'references/\u00e9.txt': 'Accent', 'references/empty.txt': '' });
  const result = await observe(f.input); assert.ok(result);
  assert.deepEqual(result.catalogBytes, f.catalogBytes);
});

test('verified reader rejects a copied foreign workspace even with the original protected receipt hash', async t => {
  const f = await fixture(t), otherId = randomUUID();
  await cp(resolve(f.active, '..'), resolve(f.native, '.dharma-managed/workspaces', otherId), { recursive: true });
  await assert.rejects(observe({ ...f.input, workspaceId: otherId }), /workspace|endpoint|authorized/i);
});

test('verified reader bounds all files even when a signed parent contains more than the package limit', async t => {
  const extras = Object.fromEntries(Array.from({ length: 514 }, (_, n) => [`references/${n}.txt`, 'x']));
  const f = await fixture(t, false, extras);
  await assert.rejects(observe(f.input), /count limit/);
});

test('verified reader bounds the total signed tree bytes independently of per-file limits', async t => {
  const extras = Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`references/${n}.txt`, 'x'.repeat(262144)]));
  const f = await fixture(t, false, extras);
  await assert.rejects(observe(f.input), /total byte limit/);
});

test('verified reader rejects oversized authorization metadata before parsing it', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.active, 'AUTHORIZATION.json'), Buffer.alloc(1048577, 'x'));
  await assert.rejects(observe(f.input), /byte limit/);
});

test('verified reader rejects hardlinked protected companions', async t => {
  const f = await fixture(t);
  await link(resolve(f.active, 'dharma-agent-fabric/knowledge/CATALOG.json'), resolve(f.home, 'outside-link.json'));
  await assert.rejects(observe(f.input), /unlinked regular/);
});

test('controlled clock advancement expires authorization before the collected bytes can return', async t => {
  const f = await fixture(t); let calls = 0;
  const input = { ...f.input, get now() { return ++calls === 1 ? new Date() : new Date(Date.parse(f.bundle.expiresAt!) + 1); } };
  await assert.rejects(observe(input), /expired/);
  assert.equal(calls, 2);
});

test('controlled pointer replacement after the initial read blocks publication of collected bytes', async t => {
  const f = await fixture(t), pointer = resolve(f.active, '..', 'ACTIVE_BUNDLE'); let changed = false;
  const input = { ...f.input, get now() {
    if (!changed) { changed = true; writeFileSync(pointer, `${randomUUID()}\n`); }
    return new Date();
  } };
  await assert.rejects(observe(input), /authorization changed/);
});
