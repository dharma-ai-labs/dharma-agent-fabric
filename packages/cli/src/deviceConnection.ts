import {readFile} from 'node:fs/promises';
import {canonicalize, validateDeviceAdmissionContract, validateTrustedServerSigningKeysetContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {AgentFabricClient, AgentFabricRequestError, parseDeviceConfig, readDeviceConnectionPreference,
  type DeviceConfig, type HostOperationScope} from '@dharma-ai-labs/agent-fabric-relay-client';

export type ConnectionFlags = Map<string, string | boolean>;

/** Only ENOENT means absent. Never convert unavailable or malformed state to enrollment. */
export async function readExistingDeviceConfig(path: string): Promise<DeviceConfig | null> {
  let bytes: string;
  try {bytes = await readFile(path, 'utf8');}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('connection_config_unreadable');
  }
  return readDeviceConnectionPreference(path, parseDeviceConfig(bytes));
}

export function connectionPreference(flags: ConnectionFlags): DeviceConfig['connectionMode'] {
  if (flags.has('unattended') && flags.has('no-unattended')
    || ['unattended', 'no-unattended'].some(key => flags.has(key) && flags.get(key) !== true)) {
    throw new Error('connection_options_invalid');
  }
  return flags.has('unattended') ? 'resume' : flags.has('no-unattended') ? 'manual' : undefined;
}

export function assertConnectionScope(config: DeviceConfig, organizationId: string, hqUrl: string) {
  if (config.organizationId !== organizationId) throw new Error('connection_scope_mismatch: this DHARMA_HOME is enrolled to a different organization. Use a separate DHARMA_HOME.');
  if (config.hqUrl !== hqUrl) throw new Error('connection_scope_mismatch: this DHARMA_HOME is enrolled to a different Dharma portal origin. Use a separate DHARMA_HOME.');
}

export async function assertInstallationContinuity(config: DeviceConfig, path: string) {
  let bytes: string;
  try {bytes = await readFile(path, 'utf8');}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && config.installationId === undefined) return;
    throw new Error('connection_installation_unavailable');
  }
  let marker: {schema?: unknown; installationId?: unknown};
  try {marker = JSON.parse(bytes) as typeof marker;} catch {throw new Error('connection_installation_corrupt');}
  if (!marker || marker.schema !== 'dharma.installation-identity/v1'
    || marker.installationId !== config.installationId) throw new Error('connection_installation_mismatch');
}

export async function assertUnenrolledHome(paths: string[]) {
  for (const path of paths) {
    try {await readFile(path);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('connection_prior_state_unreadable');
    }
    throw new Error('connection_prior_state_requires_recovery: preserve this home and resume its supported setup.');
  }
}

function assertCurrentTrust(config: DeviceConfig) {
  const keys = config.serverSigningKeyset;
  if (!keys) return; // Legacy trust still needs its protected anchor and current server admission.
  const now = Date.now();
  if (!validateTrustedServerSigningKeysetContract(keys).ok
    || keys.organizationId !== config.organizationId
    || Date.parse(keys.issuedAt) > now || Date.parse(keys.expiresAt) <= now
    || !keys.keys.some(key => key.status === 'active' && Date.parse(key.notBefore) <= now && Date.parse(key.notAfter) > now)) {
    throw new Error('connection_trust_requires_recovery');
  }
}

export type ConnectionProbeClient = Pick<AgentFabricClient, 'config' | 'openSession'>;
export async function resumeDeviceConnection(input: {
  config: DeviceConfig; configPath: string; statePath: string; installationPath: string;
  version: string; hostScope?: HostOperationScope;
  openClient?: () => Promise<ConnectionProbeClient>;
}) {
  const expected = canonicalize(input.config);
  await assertInstallationContinuity(input.config, input.installationPath);
  assertCurrentTrust(input.config);
  let instance: ConnectionProbeClient;
  try {
    instance = await (input.openClient ?? (() => AgentFabricClient.open({configPath: input.configPath,
      statePath: input.statePath, hostScope: input.hostScope, readOnly: true,
      // Admission must come from the protected HQ origin. A mutable saved relay
      // endpoint cannot establish current member/device authority.
      fetcher: (url, init) => fetch(url, {...init, redirect: 'error',
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)})})))();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('connection_config_')) throw error;
    if (/relay_host_device_identity_unavailable/.test(message)) throw new Error('connection_identity_requires_recovery');
    if (/anchor|anchored|keyset|signing|configuration does not match|Legacy device enrollment must be reauthenticated/i.test(message)) throw new Error('connection_trust_requires_recovery');
    throw new Error('connection_identity_store_unavailable');
  }
  if (canonicalize(instance.config) !== expected) throw new Error('connection_state_changed');
  try {
    const acknowledgement = await instance.openSession(input.version) as Record<string, unknown>;
    if (!validateDeviceAdmissionContract(acknowledgement)
      || acknowledgement.organizationId !== input.config.organizationId
      || acknowledgement.deviceAuthority.deviceId !== input.config.deviceId
      || acknowledgement.relayUrl !== input.config.relayUrl
      || acknowledgement.serverPublicKeyEd25519 !== input.config.serverPublicKeyEd25519) {
      throw new Error('connection_authority_unconfirmed');
    }
  } catch (error) {
    if (error instanceof AgentFabricRequestError && error.definitive) throw new Error('connection_authority_rejected: use supported approval or recovery.');
    if (error instanceof Error && error.message === 'connection_authority_unconfirmed') throw error;
    throw new Error('connection_transport_unavailable: preserve enrollment and retry when connectivity returns.');
  }
  const current = await readExistingDeviceConfig(input.configPath);
  if (!current || canonicalize(current) !== expected) throw new Error('connection_state_changed');
  await assertInstallationContinuity(input.config, input.installationPath);
  return {ok: true, status: 'resumed', connected: true, deviceId: input.config.deviceId,
    organizationId: input.config.organizationId, installationId: input.config.installationId,
    relayUrl: input.config.relayUrl, relayVersion: input.version, providerAuthentication: 'not_checked',
    admissionTransport: 'anchored_hq_https', relayTransport: 'not_checked'};
}

/** Automatic bootstrap may reuse device authority only without new authority input. */
export function automaticBootstrapResume(flags: ConnectionFlags, config: DeviceConfig | null): boolean {
  connectionPreference(flags);
  if (!config || config.connectionMode !== 'resume' || flags.has('resume')) return false;
  if (flags.has('no-unattended')) throw new Error('connection_resume_opt_in_required');
  if (flags.has('grant') || flags.has('grant-prompt') || flags.has('setup-reference')
    || flags.has('replace-existing-enrollment')) return false;
  if (!flags.has('complete') || flags.has('join-repository-binding-id') || flags.has('repository-url-base64url')) {
    throw new Error('connection_new_scope_requires_approval');
  }
  return true;
}
