import assert from 'node:assert/strict';
import test from 'node:test';
import { requireNamedSessionSignedPackage } from './namedSessionPackageGate.js';

const bundleId = '11111111-1111-4111-8111-111111111111';

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
