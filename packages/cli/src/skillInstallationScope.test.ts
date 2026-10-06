import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {runCodexBootstrapHost} from './bootstrapHostScope.js';
import {recoverLegacySkillBundleIdAfterAuthorizationFailure} from './index.js';

test('actual CLI legacy skill recovery passes the original closed setup authority to the public manager', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dharma-cli-skill-scope-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspaceId = '11111111-1111-4111-8111-111111111111', bundleId = '22222222-2222-4222-8222-222222222222';
  const managed = join(root, '.dharma-managed/workspaces', workspaceId);
  await fs.mkdir(join(managed, 'active'), {recursive: true});
  await fs.writeFile(join(managed, 'ACTIVE_BUNDLE'), bundleId);
  await fs.writeFile(join(managed, 'active/AUTHORIZATION.json'), JSON.stringify({schema: 'dharma.skill-bundle/v1', bundleId}));
  await fs.writeFile(join(managed, 'active/BUNDLE.json'), JSON.stringify({bundleId, workspaceId, skillIds: []}));
  const now = Date.now(), hash = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(runCodexBootstrapHost({workspace: root, current: async () => true,
    signal: new AbortController().signal, intent: {schema: 'dharma.codex-setup-intent/v1', operationId: workspaceId,
      setupReference: bundleId, organizationId: 'org_synthetic', recipientMembershipId: workspaceId,
      origin: 'https://example.invalid', repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash,
      contractDigest: hash, hostContextId: workspaceId, issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString()}}, async ({scope}) => {
    scope.close(); return recoverLegacySkillBundleIdAfterAuthorizationFailure({nativeSkillDirectory: root,
      workspaceId, authorizationError: new Error('synthetic')});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await fs.readFile(join(managed, 'ACTIVE_BUNDLE'), 'utf8'), bundleId);
});

test('all actual CLI skill-manager effect calls and authorization builders carry current setup authority', async () => {
  const text = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.ES2023, true);
  const names = ['getActiveSkillBundleAuthorization', 'getExpiredSkillBundleAuthorizationForReplacement',
    'getLegacySkillBundleIdForUpgrade', 'installSkillBundle', 'rollbackUnconfirmedSkillBundle',
    'readVerifiedRepositoryKnowledge', 'contentHash'];
  const current = (node: ts.Node | undefined) => !!node && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'currentBootstrapHostScope';
  const scoped = (node: ts.Node | undefined) => !!node && ts.isObjectLiteralExpression(node)
    && node.properties.some(property => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
      && property.name.text === 'hostScope' && current(property.initializer));
  let calls = 0, builders = 0;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'authorizationInput'
      && node.initializer && ts.isArrowFunction(node.initializer) && ts.isParenthesizedExpression(node.initializer.body)) {
      assert.ok(scoped(node.initializer.body.expression)); builders++;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
      const first = node.arguments[0]; calls++;
      if (node.expression.text === 'contentHash') assert.ok(current(node.arguments[1]));
      else if (first && ts.isCallExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === 'authorizationInput') {}
      else assert.ok(scoped(first), node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(calls, 10); assert.equal(builders, 2);
});
