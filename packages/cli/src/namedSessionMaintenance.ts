import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonicalize, validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import type {NamedSessionRegistration} from './namedSessionService.js';
import type {LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;

export async function maintainNamedSession(input: {
  action: 'quiesce' | 'resume' | 'stop-drained'; fenceId: string; registration: NamedSessionRegistration;
  request(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  if (!uuid.test(input.fenceId)) throw new Error('named_session_fence_invalid');
  const current = await input.request({action:'status'});
  const admission = current.admission as Record<string, unknown> | undefined;
  if (!admission || typeof admission.generation !== 'string' || !uuid.test(admission.generation)) {
    throw new Error('named_session_quiescence_not_supported');
  }
  const registration = input.registration;
  if (current.bindingId !== registration.bindingId || current.name !== registration.name
    || Object.entries(registration.identity).some(([key,value]) => current[key] !== value)) {
    throw new Error('named_session_scope_mismatch');
  }
  const result = await input.request({action:input.action, fenceId:input.fenceId, generation:admission.generation});
  if (!(await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/named-session-maintenance/v1', result)).ok
    || result.mode !== 'live' || result.action !== input.action || result.fenceId !== input.fenceId || result.generation !== admission.generation
    || result.name !== registration.name || result.bindingId !== registration.bindingId || result.sessionId !== current.sessionId
    || Object.entries(registration.identity).some(([key,value]) => result[key] !== value)) {
    throw new Error('named_session_maintenance_scope_mismatch');
  }
  return result;
}

export async function recoverStoppedNamedSession(input: {
  registration: NamedSessionRegistration; fenceId:string; workspace:string;
  processState(): Promise<'running' | 'stopped' | 'unknown'>;
  readRegistration(): Promise<NamedSessionRegistration | null>;
  readBinding(): Promise<LocalProviderSessionBinding | null>;
  saveRegistration(value: NamedSessionRegistration): Promise<void>;
  now?: () => Date;
}) {
  const registration = input.registration, fence = registration.maintenanceFence;
  if (!fence || registration.enabled || !uuid.test(input.fenceId) || !uuid.test(fence.generation) || fence.fenceId !== input.fenceId) {
    throw new Error('named_session_maintenance_recovery_unavailable');
  }
  if (await input.processState() !== 'stopped') throw new Error('named_session_owner_not_stopped');
  const binding = await input.readBinding(), now = (input.now ?? (() => new Date()))();
  if (!binding || binding.owner !== 'dharma_bridge' || binding.bindingId !== registration.bindingId
    || binding.workspaceRoot !== input.workspace || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(binding.sessionId) || !Number.isFinite(now.getTime())
    || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= now.getTime()
    || Object.entries(registration.identity).some(([key,value]) => binding[key as keyof LocalProviderSessionBinding] !== value)) {
    throw new Error('named_session_maintenance_binding_unavailable');
  }
  const current = await input.readRegistration();
  if (!current || canonicalize(current) !== canonicalize(registration)) throw new Error('named_session_maintenance_scope_mismatch');
  if (await input.processState() !== 'stopped') throw new Error('named_session_owner_not_stopped');
  const commitTime = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(commitTime.getTime()) || Date.parse(binding.expiresAt) <= commitTime.getTime()) {
    throw new Error('named_session_maintenance_binding_unavailable');
  }
  const {maintenanceFence:_fence, ...base} = registration, next = {...base, enabled:true};
  await input.saveRegistration(next);
  const readback = await input.readRegistration();
  if (!readback || canonicalize(readback) !== canonicalize(next)) throw new Error('named_session_maintenance_persistence_unconfirmed');
  return {ok:true, schema:'dharma.named-session-maintenance/v1', receiptId:randomUUID(), name:registration.name,
    bindingId:registration.bindingId, sessionId:binding.sessionId, ...registration.identity,
    action:'resume', fenceId:input.fenceId, generation:fence.generation, mode:'stopped_recovery',
    state:'restart_permitted', pending:0, automaticRestartEnabled:true,
    interruptedWorkDisposition:'preserved_for_verified_start', observedAt:commitTime.toISOString()};
}
