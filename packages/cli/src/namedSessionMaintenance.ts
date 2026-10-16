import {fileURLToPath} from 'node:url';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import type {NamedSessionRegistration} from './namedSessionService.js';

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
    || result.action !== input.action || result.fenceId !== input.fenceId || result.generation !== admission.generation
    || result.name !== registration.name || result.bindingId !== registration.bindingId || result.sessionId !== current.sessionId
    || Object.entries(registration.identity).some(([key,value]) => result[key] !== value)) {
    throw new Error('named_session_maintenance_scope_mismatch');
  }
  return result;
}
