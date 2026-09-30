const BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireNamedSessionSignedPackage(
  installation: { signedLifecycleReady: boolean; activeBundleId: string | null;
    signedMarkerBundleId: string | null },
  sharedRepositoryReady: boolean,
): string {
  if (!sharedRepositoryReady || installation.signedLifecycleReady !== true
    || !installation.activeBundleId || !BUNDLE_ID.test(installation.activeBundleId)
    || installation.signedMarkerBundleId !== installation.activeBundleId) {
    throw new Error('named_session_repository_package_pending');
  }
  return installation.activeBundleId;
}
