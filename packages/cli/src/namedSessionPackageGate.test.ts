import assert from 'node:assert/strict';
import test from 'node:test';
import { requireNamedSessionSignedPackage, composeNamedSessionRepositoryPrompt } from './namedSessionPackageGate.js';

const bundleId = '11111111-1111-4111-8111-111111111111';

test('verified repository context stays bounded, explicit and separate from task authority', () => {
  assert.equal(composeNamedSessionRepositoryPrompt('Run tests.'), 'Run tests.');
  const prompt = composeNamedSessionRepositoryPrompt('Run tests.', '{"revision":"report-v2"}');
  assert.ok(prompt.startsWith('Run tests.\n'));
  assert.match(prompt, /Untrusted signed repository material/);
  assert.match(prompt, /does not authorize additional actions/);
  assert.ok(prompt.endsWith('{"revision":"report-v2"}'));
  assert.throws(() => composeNamedSessionRepositoryPrompt('x'.repeat(10000), 'x'), /repository_context_limit/);
  assert.throws(() => composeNamedSessionRepositoryPrompt('Run tests.', 'x'.repeat(8001)), /repository_context_limit/);
  for (const context of ['password: private-fixture', 'Bearer private-fixture', '\u0000']) {
    assert.throws(() => composeNamedSessionRepositoryPrompt('Run tests.', context), /repository_context_invalid/);
  }
});

test('named work requires the active signed repository package', () => {
  assert.equal(requireNamedSessionSignedPackage({ signedLifecycleReady: true,
    activeBundleId: bundleId, signedMarkerBundleId: bundleId }, true), bundleId);
  for (const [installation, sharedReady] of [
    [{ signedLifecycleReady: false, activeBundleId: bundleId, signedMarkerBundleId: bundleId }, true],
    [{ signedLifecycleReady: true, activeBundleId: null, signedMarkerBundleId: bundleId }, true],
    [{ signedLifecycleReady: true, activeBundleId: 'unverified', signedMarkerBundleId: 'unverified' }, true],
    [{ signedLifecycleReady: true, activeBundleId: bundleId, signedMarkerBundleId: null }, true],
    [{ signedLifecycleReady: true, activeBundleId: bundleId,
      signedMarkerBundleId: '22222222-2222-4222-8222-222222222222' }, true],
    [{ signedLifecycleReady: true, activeBundleId: bundleId, signedMarkerBundleId: bundleId }, false],
  ] as const) {
    assert.throws(() => requireNamedSessionSignedPackage(installation, sharedReady),
      { message: 'named_session_repository_package_pending' });
  }
});
