import { demoRepositoryPackage, type DemoPackageDependencies } from './demoPackage.js';
import { verifyDemoDevice, type DemoDeviceScope } from './demoEnrollment.js';

export async function demoDeviceAndPackageStatus(scope: DemoDeviceScope, workspace: string,
  deps: DemoPackageDependencies = {}) {
  const connected = await verifyDemoDevice(scope, deps);
  const packageStatus = await demoRepositoryPackage({ scope, workspace, statusOnly: true }, deps);
  const { configPath: _configPath, ...receipt } = connected;
  return { ...receipt, repositoryPackageState: packageStatus.repositoryPackageState,
    repositoryPackageStateSource: 'authenticated_server_scope' as const,
    packageInstallationCheck: 'not_run' as const };
}
