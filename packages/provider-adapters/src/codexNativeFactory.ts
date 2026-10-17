import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import type { ProviderSession } from './index.js';
import { containsCredential } from './codexTurnCapture.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const eventBase = { eventId: identity, at: timestamp, actor: z.enum(['parent', 'child']),
  payloadHash: digest };
const ordinaryEvent = z.strictObject({ ...eventBase,
  kind: z.enum(['spawn', 'message', 'checkpoint', 'output']) });
const recoveryEvent = z.strictObject({ ...eventBase, kind: z.literal('recovery'), checkpointId: identity });
const acceptanceEvent = z.strictObject({ ...eventBase, kind: z.literal('parent_acceptance'),
  outputHash: digest, decision: z.enum(['accepted', 'rejected']), integrationHash: digest.nullable() });
const eventSchema = z.union([ordinaryEvent, recoveryEvent, acceptanceEvent]);

export const nativeFactoryInputSchema = z.strictObject({
  factoryTaskId: identity, parentThreadId: identity, parentTurnId: identity, childThreadId: identity,
  organizationId: identity.nullable(), workspace: z.string().min(1).max(4096),
  instructionHash: digest,
  scope: z.strictObject({ readPaths: z.array(z.string().min(1).max(4096)).max(64),
    writePaths: z.array(z.string().min(1).max(4096)).max(64),
    tools: z.array(identity).min(1).max(32),
    startedAt: timestamp, expiresAt: timestamp,
    maximumChildTurns: z.number().int().min(1).max(32),
    maximumUsd: z.number().finite().nonnegative().max(100).nullable() }),
  events: z.array(eventSchema).min(1).max(128),
});

export type NativeFactoryInput = z.infer<typeof nativeFactoryInputSchema>;
export const nativeFactoryCaptureSchema = nativeFactoryInputSchema.extend({
  schema: z.literal('dharma.codex-native-factory-capture/v1'),
  scopeHash: digest, eventsHash: digest, captureHash: digest,
  state: z.enum(['running', 'output_ready', 'accepted', 'rejected']),
  integrationState: z.enum(['not_reported', 'parent_reported']),
  coverage: z.literal('partial'), authority: z.literal('evidence_only'),
  fabricTaskId: z.null(), serverAcknowledgement: z.null(), acceptedLearningObservation: z.literal(false),
  budgetEnforcement: z.literal('not_attested'),
  limitations: z.array(z.enum(['caller_supplied_native_metadata', 'scope_enforcement_unattested',
    'budget_enforcement_unattested', 'fabric_ingestion_unqualified', 'native_turn_capture_unavailable'])).length(5),
}).strict();
export type NativeFactoryCapture = z.infer<typeof nativeFactoryCaptureSchema>;

function hash(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export interface NativeFactoryCheckpoint { contextHash: string; eventsHash: string; eventCount: number }

export function createNativeFactoryCapture(raw: unknown, expectedPrefix?: NativeFactoryCheckpoint): NativeFactoryCapture {
  const parsed = nativeFactoryInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error('native_factory_invalid');
  const input = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 256 * 1024 || containsCredential(input)) {
    throw new Error('native_factory_protected_or_oversized');
  }
  if (!posix.isAbsolute(input.workspace) && !win32.isAbsolute(input.workspace)) {
    throw new Error('native_factory_workspace_invalid');
  }
  if (input.parentThreadId === input.childThreadId) throw new Error('native_factory_identity_conflict');
  const start = Date.parse(input.scope.startedAt), end = Date.parse(input.scope.expiresAt);
  if (end <= start || end - start > 86400000) throw new Error('native_factory_window_invalid');
  const { events: supplied, ...context } = input;
  const scopeHash = hash(context), events: NativeFactoryInput['events'] = [];
  const ids = new Map<string, string>(), checkpoints = new Set<string>();
  let state: NativeFactoryCapture['state'] = 'running';
  let integrationState: NativeFactoryCapture['integrationState'] = 'not_reported';
  let lastAt = start, outputHash: string | null = null;
  for (const event of supplied) {
    const eventHash = hash(event), prior = ids.get(event.eventId);
    if (prior) {
      if (prior !== eventHash) throw new Error('native_factory_replay_conflict');
      continue;
    }
    const at = Date.parse(event.at);
    // Historical replay is valid; event admission uses the original half-open scope window, never wall-clock renewal.
    if (at < lastAt || at < start || at >= end) throw new Error('native_factory_event_time_invalid');
    if (state === 'accepted' || state === 'rejected') throw new Error('native_factory_terminal');
    if (!events.length && (event.kind !== 'spawn' || event.actor !== 'parent')) {
      throw new Error('native_factory_spawn_required');
    }
    if (events.length && event.kind === 'spawn') throw new Error('native_factory_duplicate_spawn');
    if (event.kind === 'checkpoint') checkpoints.add(event.eventId);
    if (event.kind === 'recovery' && (event.actor !== 'parent' || !checkpoints.has(event.checkpointId))) {
      throw new Error('native_factory_recovery_checkpoint_invalid');
    }
    if (event.kind === 'output') {
      if (event.actor !== 'child') throw new Error('native_factory_output_actor_invalid');
      outputHash = event.payloadHash; state = 'output_ready';
    }
    if (event.kind === 'parent_acceptance') {
      if (event.actor !== 'parent' || !outputHash || event.outputHash !== outputHash) {
        throw new Error('native_factory_acceptance_invalid');
      }
      if (event.decision === 'rejected' && event.integrationHash) throw new Error('native_factory_rejected_integration');
      state = event.decision;
      integrationState = event.integrationHash ? 'parent_reported' : 'not_reported';
    }
    ids.set(event.eventId, eventHash); events.push(event); lastAt = at;
  }
  if (expectedPrefix && (expectedPrefix.contextHash !== scopeHash
    || !Number.isInteger(expectedPrefix.eventCount) || expectedPrefix.eventCount < 1
    || expectedPrefix.eventCount > events.length
    || hash(events.slice(0, expectedPrefix.eventCount)) !== expectedPrefix.eventsHash)) {
    throw new Error('native_factory_checkpoint_conflict');
  }
  const result = { ...context, events, schema: 'dharma.codex-native-factory-capture/v1' as const,
    scopeHash, eventsHash: hash(events), state, integrationState, coverage: 'partial' as const,
    authority: 'evidence_only' as const, fabricTaskId: null, serverAcknowledgement: null,
    acceptedLearningObservation: false as const, budgetEnforcement: 'not_attested' as const,
    limitations: ['caller_supplied_native_metadata', 'scope_enforcement_unattested',
      'budget_enforcement_unattested', 'fabric_ingestion_unqualified', 'native_turn_capture_unavailable'] as const };
  return nativeFactoryCaptureSchema.parse({ ...result, captureHash: hash(result) });
}

function verifyCapture(raw: unknown): NativeFactoryCapture {
  const parsed = nativeFactoryCaptureSchema.safeParse(raw);
  if (!parsed.success) throw new Error('native_factory_capture_invalid');
  const capture = parsed.data;
  const { schema: _schema, scopeHash: _scopeHash, eventsHash: _eventsHash, captureHash: _captureHash,
    state: _state, integrationState: _integrationState, coverage: _coverage, authority: _authority,
    fabricTaskId: _task, serverAcknowledgement: _ack, acceptedLearningObservation: _learning,
    budgetEnforcement: _budget, limitations: _limitations, ...input } = capture;
  if (JSON.stringify(createNativeFactoryCapture(input)) !== JSON.stringify(capture)) {
    throw new Error('native_factory_integrity_failed');
  }
  return capture;
}

export function nativeFactoryCheckpoint(raw: unknown): NativeFactoryCheckpoint {
  const capture = verifyCapture(raw);
  return { contextHash: capture.scopeHash, eventsHash: capture.eventsHash, eventCount: capture.events.length };
}

export function nativeFactoryProviderSession(raw: unknown): ProviderSession {
  const capture = verifyCapture(raw);
  return { provider: 'codex', sessionId: `codex-factory:${capture.scopeHash}`,
    sourcePath: 'codex-native-factory-lifecycle', workspace: capture.workspace, coverage: 'partial',
    startedAt: capture.scope.startedAt, endedAt: capture.events[capture.events.length - 1]!.at,
    records: capture.events.map((event, index) => ({ sourcePath: 'codex-native-factory-lifecycle',
      line: index + 1, workspace: capture.workspace, timestamp: event.at, kind: 'metadata', coverage: 'partial',
      native: { type: 'metadata', providerItemType: 'native_factory_lifecycle',
        factoryTaskId: capture.factoryTaskId, parentThreadId: capture.parentThreadId,
        parentTurnId: capture.parentTurnId, childThreadId: capture.childThreadId,
        scopeHash: capture.scopeHash, instructionHash: capture.instructionHash,
        event, outputProvenance: 'caller_reported_hash_only',
        authority: capture.authority, acceptedLearningObservation: false,
        fabricTaskId: null, serverAcknowledgement: null } })) };
}
