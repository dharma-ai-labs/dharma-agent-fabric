import {isAbsolute, resolve} from 'node:path';
import {types} from 'node:util';

export interface LocalCodexSetupSessionRequest {
  schema: 'dharma.local-codex-setup-session/v1';
  operationId: string; intentDigest: string; setupReference: string;
  senderPid: number; senderStartTicks: string;
  organizationId: string; membershipId: string; deviceId: string; workspaceId: string;
  repositoryBindingId: string; endpointId: string; provider: 'codex';
  origin: string; repositoryFingerprint: string; policyRevision: string; policyHash: string;
  scopeDigest: string; contractDigest: string;
  name: string; workspaceRoot: string; maximumCostCents: number; maximumTurnCostCents: number;
  issuedAt: string; expiresAt: string;
}
export type LocalCodexSetupSessionResult = {state: 'started'; bindingId: string; sessionId: string;
  sessionPid: number; supervisorPid: number; sessionStartTicks: string; supervisorStartTicks: string}
  | {state: 'unconfirmed'; code: 'session_start_unconfirmed'};
export interface LocalCodexSetupSessionObservation {
  state: 'pending' | 'accepted' | 'withdrawn';
  request: Readonly<LocalCodexSetupSessionRequest>;
  result: Readonly<LocalCodexSetupSessionResult> | null;
}
export interface LocalCodexSetupSessionSubmission {withdraw(): void;}
export interface ScopedCodexSetupSessionSubmission {withdraw(): Promise<void>;}
export interface LocalCodexSetupSessionAcceptance {
  request: Readonly<LocalCodexSetupSessionRequest>;
  record(result: LocalCodexSetupSessionResult): void;
}
export interface ScopedCodexSetupSessionAcceptance extends Omit<LocalCodexSetupSessionAcceptance, 'record'> {
  record(result: LocalCodexSetupSessionResult): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const hash = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const ids = ['operationId', 'setupReference', 'membershipId', 'deviceId', 'workspaceId', 'repositoryBindingId', 'endpointId'];
const hashes = ['intentDigest', 'repositoryFingerprint', 'policyHash', 'scopeDigest', 'contractDigest'];
const fields = ['schema', ...ids, ...hashes, 'senderPid', 'senderStartTicks', 'organizationId', 'provider', 'origin', 'policyRevision', 'name',
  'workspaceRoot', 'maximumCostCents', 'maximumTurnCostCents', 'issuedAt', 'expiresAt'];
function snapshot(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) throw new Error('setup_session_invalid');
  const properties = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(properties);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(properties[key]!, 'value') || !properties[key]!.enumerable)) throw new Error('setup_session_invalid');
  return Object.fromEntries(keys.map(key => [key, properties[key]!.value]));
}
export function parseLocalCodexSetupSessionRequest(value: unknown): Readonly<LocalCodexSetupSessionRequest> {
  const result = snapshot(value, fields);
  if (typeof result.origin !== 'string' || typeof result.issuedAt !== 'string' || typeof result.expiresAt !== 'string') {
    throw new Error('setup_session_invalid');
  }
  let origin: URL; try {origin = new URL(result.origin);} catch {throw new Error('setup_session_invalid');}
  const issued = Date.parse(result.issuedAt), expires = Date.parse(result.expiresAt);
  if (result.schema !== 'dharma.local-codex-setup-session/v1' || result.provider !== 'codex'
    || !Number.isSafeInteger(result.senderPid) || Number(result.senderPid) < 1 || Number(result.senderPid) > 2147483647
    || typeof result.senderStartTicks !== 'string' || !/^[0-9]{1,30}$(?![\s\S])/.test(result.senderStartTicks)
    || ids.some(key => typeof result[key] !== 'string' || !uuid.test(result[key]))
    || hashes.some(key => typeof result[key] !== 'string' || !hash.test(result[key]))
    || typeof result.organizationId !== 'string' || result.organizationId.length > 200 || !/^org_[A-Za-z0-9]+$(?![\s\S])/.test(result.organizationId)
    || typeof result.origin !== 'string' || result.origin.length > 2048 || origin.protocol !== 'https:' || origin.origin !== result.origin || origin.username || origin.password
    || typeof result.policyRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(result.policyRevision)
    || typeof result.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$(?![\s\S])/.test(result.name)
    || typeof result.workspaceRoot !== 'string' || result.workspaceRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(result.workspaceRoot)
    || !isAbsolute(result.workspaceRoot) || resolve(result.workspaceRoot) !== result.workspaceRoot
    || !Number.isSafeInteger(result.maximumCostCents) || Number(result.maximumCostCents) < 1 || Number(result.maximumCostCents) > 10000
    || !Number.isSafeInteger(result.maximumTurnCostCents) || Number(result.maximumTurnCostCents) < 1
    || Number(result.maximumTurnCostCents) > Number(result.maximumCostCents)
    || typeof result.issuedAt !== 'string' || typeof result.expiresAt !== 'string'
    || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 900000
    || new Date(issued).toISOString() !== result.issuedAt || new Date(expires).toISOString() !== result.expiresAt) {
    throw new Error('setup_session_invalid');
  }
  return Object.freeze(result) as unknown as Readonly<LocalCodexSetupSessionRequest>;
}
export function parseLocalCodexSetupSessionResult(value: unknown): Readonly<LocalCodexSetupSessionResult> {
  const keys = value && typeof value === 'object' && !types.isProxy(value)
    && Object.getOwnPropertyDescriptor(value, 'state')?.value === 'unconfirmed'
    ? ['state', 'code'] : ['state', 'bindingId', 'sessionId', 'sessionPid', 'supervisorPid', 'sessionStartTicks', 'supervisorStartTicks'];
  const result = snapshot(value, keys);
  if (result.state === 'unconfirmed' && result.code === 'session_start_unconfirmed') return Object.freeze(result) as LocalCodexSetupSessionResult;
  if (result.state !== 'started' || typeof result.bindingId !== 'string' || !uuid.test(result.bindingId)
    || typeof result.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(result.sessionId)
    || ['sessionPid', 'supervisorPid'].some(key => !Number.isSafeInteger(result[key]) || Number(result[key]) < 1 || Number(result[key]) > 2147483647)
    || ['sessionStartTicks', 'supervisorStartTicks'].some(key => typeof result[key] !== 'string' || !/^[0-9]{1,30}$(?![\s\S])/.test(result[key]))) {
    throw new Error('setup_session_invalid');
  }
  return Object.freeze(result) as unknown as Readonly<LocalCodexSetupSessionResult>;
}
