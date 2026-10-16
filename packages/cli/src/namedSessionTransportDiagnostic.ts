import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {LocalProviderSessionIdentity} from '@dharma-ai-labs/agent-fabric-local-vault';

const phases = ['connect','write','response','decode','remote'] as const;
const reasons = ['socket_missing','connection_refused','permission_denied','connection_reset','timeout',
  'transport_error','connection_closed','response_too_large','malformed_response','remote_rejected'] as const;
const osCodes = new Set(['ENOENT','ECONNREFUSED','EACCES','EPERM','ECONNRESET','ETIMEDOUT','EPIPE']);
const remoteCodes = new Set(['named_session_unavailable','named_session_failed','named_session_stopped',
  'named_session_busy','named_session_quiesced','named_session_readiness_unavailable',
  'named_session_readiness_scope_mismatch','named_session_native_skill_unavailable',
  'named_session_scope_mismatch','named_session_registration_invalid','setup_session_invalid',
  'setup_session_scope_changed','setup_readiness_stale','vault_api_unavailable']);

export type NamedSessionTransportPhase = typeof phases[number];
export type NamedSessionTransportReason = typeof reasons[number];
export interface NamedSessionTransportDiagnostic {
  readonly schema: 'dharma.named-session-transport-diagnostic/v1';
  readonly phase: NamedSessionTransportPhase;
  readonly reason: NamedSessionTransportReason;
  readonly osCode: string | null;
  readonly remoteCode: string | null;
}

export function namedSessionReadinessDiagnosticRequested(action: string, flags: Map<string,string | boolean>) {
  if (!flags.has('diagnostic')) return false;
  if (action !== 'readiness' || flags.get('diagnostic') !== true
    || [...flags.keys()].some(key => !['name','workspace-id','diagnostic'].includes(key))) {
    throw new Error('named_session_diagnostic_invalid');
  }
  return true;
}

/** A closed local observation, never a copy of a socket error or remote body. */
export class NamedSessionTransportFailure extends Error {
  readonly #diagnostic: Readonly<NamedSessionTransportDiagnostic>;
  constructor(phase: NamedSessionTransportPhase, reason: NamedSessionTransportReason,
    osCode: unknown = null, remoteCode: unknown = null) {
    super('named_session_unavailable');
    this.name = 'NamedSessionTransportFailure';
    this.#diagnostic = Object.freeze({schema:'dharma.named-session-transport-diagnostic/v1',
      phase:phases.includes(phase) ? phase : 'response', reason:reasons.includes(reason) ? reason : 'transport_error',
      osCode:typeof osCode === 'string' && osCodes.has(osCode) ? osCode : null,
      remoteCode:typeof remoteCode === 'string' && remoteCodes.has(remoteCode) ? remoteCode : null});
  }
  get diagnostic() {return this.#diagnostic;}

  static fromSocket(phase: NamedSessionTransportPhase, error: unknown) {
    const field = error && typeof error === 'object' && !types.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error,'code') : undefined;
    const code: unknown = field && Object.hasOwn(field,'value') ? field.value : undefined;
    const reason = code === 'ENOENT' ? 'socket_missing' : code === 'ECONNREFUSED' ? 'connection_refused'
      : code === 'EACCES' || code === 'EPERM' ? 'permission_denied'
        : code === 'ECONNRESET' || code === 'EPIPE' ? 'connection_reset'
          : code === 'ETIMEDOUT' ? 'timeout' : 'transport_error';
    return new NamedSessionTransportFailure(phase,reason,code);
  }
}

export function namedSessionReadinessDiagnostic(input: {readonly name:string; readonly bindingId:string;
  readonly identity:LocalProviderSessionIdentity}, failure: NamedSessionTransportFailure) {
  const own = (value: unknown, key: string) => {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const field = Object.getOwnPropertyDescriptor(value,key);
    return field && Object.hasOwn(field,'value') ? field.value : undefined;
  };
  const name: unknown = own(input,'name'), bindingId: unknown = own(input,'bindingId');
  const identity: unknown = own(input,'identity');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
  const organizationId: unknown = own(identity,'organizationId');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$(?![\s\S])/.test(name)
    || typeof bindingId !== 'string' || !uuid.test(bindingId)
    || typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$(?![\s\S])/.test(organizationId)
    || own(identity,'provider') !== 'codex') throw new Error('named_session_diagnostic_scope_invalid');
  const ids: Record<string,string> = {};
  for (const key of ['repositoryBindingId','workspaceId','endpointId','membershipId','deviceId']) {
    const value: unknown = own(identity,key);
    if (typeof value !== 'string' || !uuid.test(value)) throw new Error('named_session_diagnostic_scope_invalid');
    ids[key] = value;
  }
  return Object.freeze({ok:false, schema:'dharma.named-session-readiness-diagnostic/v1', localOnly:true,
    nativeReady:false, receiptId:randomUUID(), observedAt:new Date().toISOString(), name, bindingId,
    organizationId, ...ids, provider:'codex', code:'named_session_unavailable', diagnostic:failure.diagnostic});
}
