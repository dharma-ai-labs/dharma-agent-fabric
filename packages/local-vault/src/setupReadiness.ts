import {types} from 'node:util';

/** A verified-state snapshot, not a signature or proof of continued liveness.
 * The trusted producer supplies independently observed state; consumers must
 * reobserve it before reporting current readiness. No private paths or keys. */
export interface LocalCodexSetupReadiness {
  schema: 'dharma.local-codex-setup-readiness/v1';
  operationId: string;
  organizationId: string;
  membershipId: string;
  deviceId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
  endpointId: string;
  sessionBindingId: string;
  sessionId: string;
  repositoryFingerprint: string;
  policyRevision: string;
  policyHash: string;
  manifestHash: string;
  catalogHash: string;
  bundleId: string;
  bundleHash: string;
  activeReceiptHash: string;
  roleRevision: number;
  roleProfileHash: string;
  nativeSkillHash: string;
  contractDigest: string;
  cliVersion: string;
  relayPid: number;
  relayPolledAt: string;
  startupBackend: 'systemd-user' | 'container-entrypoint';
  firstLearning: 'synchronized' | 'no_eligible_history' | 'denied_disclosure';
  verifiedAt: string;
  expiresAt: string;
}

export interface LocalCodexSetupReadinessReceipt {
  receiptId: string;
  intentDigest: string;
  observationHash: string;
  observation: LocalCodexSetupReadiness;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const hash = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const ids = ['operationId', 'membershipId', 'deviceId', 'workspaceId', 'repositoryBindingId',
  'repositoryAgentId', 'endpointId', 'sessionBindingId', 'bundleId'];
const hashes = ['repositoryFingerprint', 'policyHash', 'manifestHash', 'catalogHash', 'bundleHash',
  'activeReceiptHash', 'roleProfileHash', 'nativeSkillHash', 'contractDigest'];
const fields = ['schema', ...ids, ...hashes, 'organizationId', 'sessionId', 'policyRevision',
  'roleRevision', 'cliVersion', 'relayPid', 'relayPolledAt', 'startupBackend', 'firstLearning', 'verifiedAt', 'expiresAt'];

export function parseLocalCodexSetupReadiness(value: unknown): LocalCodexSetupReadiness {
  const invalid = (): never => {throw new Error('setup_readiness_invalid');};
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) return invalid();
  const snapshot = Object.fromEntries(fields.map(key => [key, descriptors[key]!.value]));
  if (snapshot.schema !== 'dharma.local-codex-setup-readiness/v1'
    || ids.some(key => typeof snapshot[key] !== 'string' || !uuid.test(snapshot[key]))
    || hashes.some(key => typeof snapshot[key] !== 'string' || !hash.test(snapshot[key]))
    || typeof snapshot.organizationId !== 'string' || !/^org_[A-Za-z0-9]+$(?![\s\S])/.test(snapshot.organizationId)
    || typeof snapshot.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(snapshot.sessionId)
    || typeof snapshot.policyRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(snapshot.policyRevision)
    || !Number.isSafeInteger(snapshot.roleRevision) || snapshot.roleRevision < 1 || snapshot.roleRevision > 2147483647
    || !Number.isSafeInteger(snapshot.relayPid) || snapshot.relayPid < 1 || snapshot.relayPid > 2147483647
    || typeof snapshot.cliVersion !== 'string' || !/^0\.2\.(?:0|[1-9][0-9]{0,5})$(?![\s\S])/.test(snapshot.cliVersion)
    || !['systemd-user', 'container-entrypoint'].includes(snapshot.startupBackend)
    || !['synchronized', 'no_eligible_history', 'denied_disclosure'].includes(snapshot.firstLearning)) return invalid();
  const times = ['relayPolledAt', 'verifiedAt', 'expiresAt'].map(key => {
    const time = snapshot[key];
    if (typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) return invalid();
    return Date.parse(time);
  });
  if (times[0]! > times[1]! || times[1]! - times[0]! > 60_000
    || times[2]! <= times[1]! || times[2]! - times[1]! > 900_000) return invalid();
  return Object.freeze(snapshot) as unknown as LocalCodexSetupReadiness;
}
