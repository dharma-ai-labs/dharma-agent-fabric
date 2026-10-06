import { join } from 'node:path';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionBinding, LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { assertPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { AgentFabricRequestError } from '@dharma-ai-labs/agent-fabric-relay-client';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { prepareNamedSessionTaskExport, type NamedSessionTaskExportInput } from './namedSessionTaskExport.js';

interface Descriptor extends Omit<LocalProviderSessionIdentity, 'provider'> {
  schema: 'dharma.named-session-task-export-outbox/v1';
  bindingId: string; workId: string; workKey: string; captureHash: string; contextHash: string;
  exportHash: string; policyRevision: string; consentReceiptId: string; createdAt: string;
}
interface UploadReceipt {
  ok: true; organizationId: string; correlationId: string;
  receipt: { id: string; status: 'retained' | 'duplicate'; exportHash: string; contentExpiresAt: string;
    acceptedLearningObservation: false };
}
export interface NamedSessionTaskExportSyncResult {
  state: 'idle' | 'delivered' | 'pending' | 'blocked'; pending: number | null; delivered: number;
  code?: string; lastReceipt?: UploadReceipt; acceptedLearningObservation: false;
}
const identityKeys = ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId', 'deviceId'] as const;
const schemas = join(import.meta.dirname, 'schemas');

function identity(binding: LocalProviderSessionBinding): LocalProviderSessionIdentity {
  return { organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, provider: binding.provider };
}

function authorized(policy: OrganizationPolicy, descriptor: Descriptor) {
  try { assertPolicy(policy); } catch { return false; }
  return policy.organizationId === descriptor.organizationId && policy.revision === descriptor.policyRevision
    && policy.serverAuthorization?.workspaceId === descriptor.workspaceId
    && policy.evidence.automaticDisclosure?.mode === 'customer_authorized_content'
    && policy.evidence.automaticDisclosure.consentReceiptId === descriptor.consentReceiptId;
}

export async function stageNamedSessionTaskExport(vault: LocalVault | ScopedLocalVault, input: NamedSessionTaskExportInput) {
  const snapshot = { ...input, binding: structuredClone(input.binding), capture: structuredClone(input.capture),
    contextBytes: Buffer.from(input.contextBytes) };
  const scope = identity(snapshot.binding);
  const current = await vault.getProviderSessionBinding(snapshot.binding.bindingId, scope);
  if (!current || current.sessionId !== snapshot.binding.sessionId || current.workspaceRoot !== snapshot.binding.workspaceRoot) {
    throw new Error('named_session_task_export_binding_unavailable');
  }
  const exported = await prepareNamedSessionTaskExport(snapshot);
  if (exported.state !== 'ready') return { exported };
  const captureHash = await vault.putBlob(Buffer.from(JSON.stringify(snapshot.capture)), 'raw-provider-turn');
  const contextHash = await vault.putBlob(snapshot.contextBytes, 'named-session-public-context');
  const exportHash = await vault.putBlob(Buffer.from(exported.bytes), 'named-session-portable-task-export');
  if (contextHash !== input.contextHash || exportHash !== exported.exportHash) throw new Error('named_session_task_export_integrity_failed');
  const workKey = sha256(canonicalize({ ...scope, bindingId: current.bindingId, workId: snapshot.capture.workId }));
  // The closed-at timestamp is immutable, so staging retries retain the same descriptor hash.
  const descriptor = { schema: 'dharma.named-session-task-export-outbox/v1',
    ...Object.fromEntries(identityKeys.map(key => [key, current[key]])), bindingId: current.bindingId,
    workId: snapshot.capture.workId, workKey, captureHash, contextHash, exportHash,
    policyRevision: input.policy.revision, consentReceiptId: input.policy.evidence.automaticDisclosure!.consentReceiptId,
    createdAt: snapshot.capture.closedAt };
  const valid = await validateContract(schemas, 'https://schemas.dharma-ai.io/named-session-task-export-outbox/v1', descriptor);
  if (!valid.ok) throw new Error('named_session_task_export_descriptor_invalid');
  const descriptorHash = await vault.stageProviderSessionTaskExport(current.bindingId, scope, workKey,
    Buffer.from(canonicalize(descriptor)));
  return { exported, outbox: { state: 'pending' as const, workKey, descriptorHash, acceptedLearningObservation: false as const } };
}

export async function syncNamedSessionTaskExports(input: {
  vault: LocalVault | ScopedLocalVault; bindingId: string; identity: LocalProviderSessionIdentity;
  loadPolicy(): Promise<OrganizationPolicy>;
  send(body: { schema: 'dharma.codex-task-export-upload/v1'; exportBytes: string; exportHash: string }): Promise<unknown>;
}): Promise<NamedSessionTaskExportSyncResult> {
  let delivered = 0, pending = 0, pendingKnown = false;
  let lastReceipt: UploadReceipt | undefined;
  const result = (state: NamedSessionTaskExportSyncResult['state'], code?: string): NamedSessionTaskExportSyncResult =>
    ({ state, pending: pendingKnown ? pending : null, delivered, ...(code ? { code } : {}),
      ...(lastReceipt ? { lastReceipt } : {}), acceptedLearningObservation: false });
  let rows: Array<{ workKey: string; descriptorHash: string }>;
  try { rows = await input.vault.listProviderSessionTaskExports(input.bindingId, input.identity); }
  catch { return result('blocked', 'task_export_binding_unavailable'); }
  pending = rows.length;
  pendingKnown = true;
  try {
    const prior = await input.vault.latestProviderSessionTaskExportReceipt(input.bindingId, input.identity);
    if (prior) {
      const receipt: unknown = JSON.parse((await input.vault.getBlob(prior.receiptHash)).toString('utf8'));
      const descriptor: unknown = JSON.parse((await input.vault.getBlob(prior.descriptorHash)).toString('utf8'));
      const receiptValid = await validateContract(schemas, 'https://schemas.dharma-ai.io/codex-task-export-upload-receipt/v1', receipt);
      const descriptorValid = await validateContract(schemas, 'https://schemas.dharma-ai.io/named-session-task-export-outbox/v1', descriptor);
      const checked = receipt as UploadReceipt, original = descriptor as Descriptor;
      if (!receiptValid.ok || !descriptorValid.ok || checked.organizationId !== input.identity.organizationId
        || original.bindingId !== input.bindingId || identityKeys.some(key => original[key] !== input.identity[key])
        || checked.receipt.exportHash !== original.exportHash) return result('blocked', 'task_export_saved_receipt_invalid');
      lastReceipt = checked;
    }
  } catch { return result('blocked', 'task_export_saved_receipt_unavailable'); }
  if (!pending) return result('idle');
  for (const row of rows.slice(0, 5)) {
    let descriptor: Descriptor, capture: CodexLocalWorkCapture, contextBytes: Buffer, retained: string;
    try {
      const bytes = await input.vault.getBlob(row.descriptorHash);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      descriptor = JSON.parse(text);
      const valid = await validateContract(schemas, 'https://schemas.dharma-ai.io/named-session-task-export-outbox/v1', descriptor);
      if (!valid.ok || canonicalize(descriptor) !== text || descriptor.bindingId !== input.bindingId
        || descriptor.workKey !== row.workKey || identityKeys.some(key => descriptor[key] !== input.identity[key])) {
        return result('blocked', 'task_export_descriptor_invalid');
      }
      capture = JSON.parse((await input.vault.getBlob(descriptor.captureHash)).toString('utf8'));
      contextBytes = await input.vault.getBlob(descriptor.contextHash);
      retained = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await input.vault.getBlob(descriptor.exportHash));
      if (capture.workId !== descriptor.workId || sha256(JSON.stringify(capture)) !== descriptor.captureHash) {
        return result('blocked', 'task_export_capture_invalid');
      }
    } catch { return result('blocked', 'task_export_retained_content_unavailable'); }
    let policy: OrganizationPolicy;
    try { policy = await input.loadPolicy(); }
    catch { return result('pending', 'task_export_policy_refresh_pending'); }
    if (!authorized(policy, descriptor)) return result('blocked', 'task_export_original_consent_unavailable');
    let binding: LocalProviderSessionBinding | null;
    try { binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity); }
    catch { return result('blocked', 'task_export_binding_unavailable'); }
    if (!binding) return result('blocked', 'task_export_binding_unavailable');
    const prepared = await prepareNamedSessionTaskExport({ capture, binding, contextBytes, contextHash: descriptor.contextHash, policy });
    if (prepared.state !== 'ready') return result('blocked', prepared.code);
    if (prepared.exportHash !== descriptor.exportHash || prepared.bytes !== retained) return result('blocked', 'task_export_projection_changed');
    // Refresh again after file reads/schema loading; a stale consent cannot authorize transmission.
    try { policy = await input.loadPolicy(); }
    catch { return result('pending', 'task_export_policy_refresh_pending'); }
    if (!authorized(policy, descriptor)) return result('blocked', 'task_export_original_consent_unavailable');
    const final = await prepareNamedSessionTaskExport({ capture, binding, contextBytes, contextHash: descriptor.contextHash, policy });
    if (final.state !== 'ready') return result('blocked', final.code);
    if (final.exportHash !== descriptor.exportHash || final.bytes !== retained) return result('blocked', 'task_export_projection_changed');
    try {
      if (!await input.vault.getProviderSessionBinding(input.bindingId, input.identity)) return result('blocked', 'task_export_binding_unavailable');
      assertPolicy(policy);
    } catch { return result('blocked', 'task_export_current_authority_unavailable'); }
    let response: unknown;
    try { response = await input.send({ schema: 'dharma.codex-task-export-upload/v1', exportBytes: retained, exportHash: descriptor.exportHash }); }
    catch (error) {
      if (error instanceof AgentFabricRequestError && error.definitive) {
        const code = error.message.split(':', 1)[0]!;
        return result('blocked', ['codex_task_export_access_denied', 'content_consent_not_active',
          'content_capsule_limit_exceeded', 'codex_task_export_conflict', 'codex_task_export_invalid'].includes(code)
          ? code : 'task_export_delivery_rejected');
      }
      return result('pending', 'task_export_delivery_pending');
    }
    try { response = structuredClone(response); }
    catch { return result('blocked', 'task_export_receipt_invalid'); }
    const receiptCheck = await validateContract(schemas, 'https://schemas.dharma-ai.io/codex-task-export-upload-receipt/v1', response);
    const receipt = response as UploadReceipt;
    if (!receiptCheck.ok || receipt.organizationId !== descriptor.organizationId
      || receipt.receipt.exportHash !== descriptor.exportHash || Date.parse(receipt.receipt.contentExpiresAt) <= Date.now()) {
      return result('blocked', 'task_export_receipt_invalid');
    }
    // Retain the evidence-backed response encrypted before retiring this pending entry.
    try {
      const receiptHash = await input.vault.putBlob(Buffer.from(canonicalize(receipt)), 'named-session-task-export-receipt');
      await input.vault.acknowledgeProviderSessionTaskExport(input.bindingId, input.identity, row.workKey, row.descriptorHash, receiptHash);
    } catch { return result('blocked', 'task_export_acknowledgement_unavailable'); }
    delivered++; pending--; lastReceipt = receipt;
  }
  return result(pending ? 'pending' : 'delivered');
}
