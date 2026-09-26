import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { redactValue, type RedactionStats } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { AgentFabricHandoffInput, AgentFabricRequestOptions } from '@dharma-ai-labs/agent-fabric-sdk';
import eventSchema from './lifecycle-event.schema.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const ajv = new Ajv2020({ strict: true, strictRequired: false });
require('ajv-formats').default(ajv);
const validEvent = ajv.compile(eventSchema) as (value: unknown) => boolean;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const STATE_APPLICATION_ID = 0x44464c41;
const ACTIONS = {
  reviewed_plan_to_implementation: 'propose_implementation_of_reviewed_plan',
  implementation_to_review: 'review_implementation',
  approved_brief_to_draft: 'propose_draft_for_approved_brief',
  draft_to_review: 'review_creative_draft',
} as const;

export interface LifecycleEvent {
  schema: 'dharma.lifecycle-event/v1';
  eventId: string; revision: number; organizationId: string; repositoryBindingId: string;
  workspaceId: string; sourceEndpointId: string; targetEndpointId: string; targetWorkspaceId: string;
  sourceTaskId: string; workflow: 'coding' | 'creative'; boundary: keyof typeof ACTIONS;
  sourceCommit: string; sourceHash: string; occurredAt: string; expiresAt: string;
  intent: string; summary: string; missing: string[];
  evidenceReferences: NonNullable<AgentFabricHandoffInput['evidenceReferences']>;
}
export interface LifecycleScope {
  organizationId: string; repositoryBindingId: string; workspaceId: string; sourceEndpointId: string;
  targets: Array<{ endpointId: string; workspaceId: string }>;
}
export type LifecycleAuthorityRequest = Omit<LifecycleEvent, 'intent' | 'summary' | 'missing' | 'evidenceReferences'>;
export type LifecycleAuthorization = { approved: false } | { approved: true; policyRevision: string };
export interface LifecycleSourceOptions {
  sourcePath: string; scope: LifecycleScope;
  authorize(input: Readonly<LifecycleAuthorityRequest>): Promise<LifecycleAuthorization>;
  now?: Date; batchSize?: number; requestTimeoutMs?: number;
}
export class LifecycleAdapterError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new LifecycleAdapterError(code); }
function validateScope(scope: LifecycleScope) {
  if (!scope || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$(?![\s\S])/.test(scope.organizationId)
    || ![scope.repositoryBindingId, scope.workspaceId, scope.sourceEndpointId].every(id => UUID.test(id))
    || !Array.isArray(scope.targets) || !scope.targets.length || scope.targets.length > 20
    || scope.targets.some(target => !UUID.test(target.endpointId) || !UUID.test(target.workspaceId)
      || target.endpointId === scope.sourceEndpointId)
    || new Set(scope.targets.map(target => target.endpointId)).size !== scope.targets.length) fail('lifecycle_scope_invalid');
}
function batchSize(input: LifecycleSourceOptions) {
  const size = input.batchSize ?? 20;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) fail('lifecycle_batch_invalid');
  return size;
}
function requestTimeout(input: LifecycleSourceOptions) {
  const timeout = input.requestTimeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) fail('lifecycle_timeout_invalid');
  return timeout;
}
async function sourceDatabase(path: string) {
  if (!isAbsolute(path)) fail('lifecycle_source_invalid');
  const canonicalPath = await realpath(path);
  if (!(await lstat(canonicalPath)).isFile()) fail('lifecycle_source_invalid');
  const source = new DatabaseSync(canonicalPath, { readOnly: true, allowExtension: false });
  source.exec('PRAGMA query_only = ON;');
  return { source, canonicalPath };
}
function readRows(source: DatabaseSync, cursor: number, limit: number) {
  try {
    const rows = source.prepare(`SELECT sequence,
      CASE WHEN length(CAST(event_json AS BLOB)) <= 16384 THEN event_json ELSE NULL END AS event_json
      FROM dharma_lifecycle_export_v1 WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(cursor, limit);
    let last = cursor;
    for (const row of rows) {
      if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence <= last) {
        fail('lifecycle_sequence_invalid');
      }
      last = row.sequence;
    }
    return rows as Array<{ sequence: number; event_json: string | null }>;
  } catch (error) {
    if (error instanceof LifecycleAdapterError) throw error;
    fail('lifecycle_projection_unavailable');
  }
}
function parseEvent(json: string | null, scope: LifecycleScope): LifecycleEvent {
  if (typeof json !== 'string') fail('lifecycle_event_too_large');
  let value: unknown;
  try { value = JSON.parse(json); } catch { fail('lifecycle_event_invalid'); }
  if (!validEvent(value)) fail('lifecycle_event_invalid');
  const event = value as LifecycleEvent;
  if (event.organizationId !== scope.organizationId || event.repositoryBindingId !== scope.repositoryBindingId
    || event.workspaceId !== scope.workspaceId || event.sourceEndpointId !== scope.sourceEndpointId
    || !scope.targets.some(target => target.endpointId === event.targetEndpointId && target.workspaceId === event.targetWorkspaceId)) {
    fail('lifecycle_scope_mismatch');
  }
  if (Date.parse(event.expiresAt) <= Date.parse(event.occurredAt)) fail('lifecycle_event_invalid');
  if (Date.parse(event.expiresAt) - Date.parse(event.occurredAt) > 900000) fail('lifecycle_event_invalid');
  return event;
}
async function prepare(event: LifecycleEvent, input: LifecycleSourceOptions) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail('lifecycle_time_invalid');
  const eventHash = sha256(canonicalize(event));
  if (Date.parse(event.occurredAt) > now.getTime()) fail('lifecycle_event_future');
  if (Date.parse(event.expiresAt) <= now.getTime()) return { state: 'expired' as const, eventHash };
  const { intent, summary, missing, evidenceReferences, ...metadata } = event;
  const permission = await input.authorize(Object.freeze({ ...metadata }));
  if (!permission || permission.approved !== true) fail('lifecycle_policy_denied');
  if (typeof permission.policyRevision !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(permission.policyRevision)) {
    fail('lifecycle_policy_invalid');
  }
  if (Date.parse(event.expiresAt) <= (input.now ?? new Date()).getTime()) return { state: 'expired' as const, eventHash };
  const stats: RedactionStats = { classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  const safe = redactValue({ intent, summary, missing }, stats) as { intent: string; summary: string; missing: string[] };
  const handoff: AgentFabricHandoffInput = {
    sourceTaskId: event.sourceTaskId, targetEndpointId: event.targetEndpointId,
    // Stable conversation and idempotency IDs make a lost response replayable.
    conversationId: event.eventId, requestedResponse: 'proposal',
    stateEnvelope: { intent: safe.intent, evidence_used: [`approved source ${event.sourceHash}`],
      known_state: { lifecycle_event: { ...metadata, eventHash, policyRevision: permission.policyRevision },
        source_revision: { commit: event.sourceCommit, contentHash: event.sourceHash }, summary: safe.summary },
      unknown_or_missing_state: safe.missing, allowed_next_actions: [ACTIONS[event.boundary]],
      blocked_actions: ['publishing', 'spending', 'permission_expansion', 'scheduler_replacement'],
      decision_authority: 'Customer scheduler and existing human approvals retain execution, publishing and spending authority.',
      tool_results: [] }, evidenceReferences,
  };
  if (Buffer.byteLength(JSON.stringify(handoff.stateEnvelope)) > 12000) fail('lifecycle_handoff_too_large');
  const requestHash = sha256(canonicalize(handoff));
  const idempotencyKey = `lifecycle-${sha256(canonicalize({ organizationId: event.organizationId,
    repositoryBindingId: event.repositoryBindingId, eventId: event.eventId, revision: event.revision })).slice(7)}`;
  return { state: 'planned' as const, eventHash, requestHash, idempotencyKey, handoff, redactedValues: stats.redactedValues };
}
export async function previewLifecycleSource(input: LifecycleSourceOptions & { afterSequence?: number }) {
  validateScope(input.scope);
  const cursor = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail('lifecycle_cursor_invalid');
  const { source } = await sourceDatabase(input.sourcePath);
  try {
    const planned = [];
    for (const row of readRows(source, cursor, batchSize(input))) {
      const event = parseEvent(row.event_json, input.scope);
      planned.push({ sequence: row.sequence, eventId: event.eventId, revision: event.revision, ...await prepare(event, input) });
    }
    return planned;
  } finally { source.close(); }
}
export interface LifecycleHandoffTransport {
  readonly organizationId: string;
  dispatchHandoff(input: AgentFabricHandoffInput, options?: AgentFabricRequestOptions): Promise<Record<string, unknown>>;
}
function receipt(response: Record<string, unknown>, event: LifecycleEvent, eventHash: string, requestHash: string) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) fail('lifecycle_response_invalid');
  const task = response.task as Record<string, unknown> | undefined;
  const message = response.message as Record<string, unknown> | undefined;
  const state = message?.state_envelope as AgentFabricHandoffInput['stateEnvelope'] | undefined;
  const echoed = state?.known_state?.lifecycle_event as Record<string, unknown> | undefined;
  const envelope = task?.envelope as { source?: { taskId?: unknown; endpointId?: unknown } } | undefined;
  if (response.ok !== true || response.organizationId !== event.organizationId
    || !UUID.test(String(response.correlationId || ''))
    || !task || !message || !UUID.test(String(task.id || '')) || !UUID.test(String(message.id || ''))
    || task.org_id !== event.organizationId || task.target_endpoint_id !== event.targetEndpointId
    || task.source_endpoint_id !== event.sourceEndpointId || envelope?.source?.taskId !== event.sourceTaskId
    || envelope?.source?.endpointId !== event.sourceEndpointId
    || task.workspace_id !== event.targetWorkspaceId || task.status !== 'offered'
    || message.org_id !== event.organizationId || message.task_id !== task.id
    || message.conversation_id !== event.eventId || message.source_endpoint_id !== event.sourceEndpointId
    || message.target_endpoint_id !== event.targetEndpointId || echoed?.eventHash !== eventHash) fail('lifecycle_response_invalid');
  const observation = { taskId: String(task.id), messageId: String(message.id),
    correlationId: String(response.correlationId), eventHash, requestHash };
  return { ...observation, observationHash: sha256(canonicalize(observation)) };
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class SqliteLifecycleAdapter {
  #running = false;
  private constructor(private readonly options: LifecycleSourceOptions & { statePath: string; streamId: string },
    private readonly source: DatabaseSync, private readonly state: DatabaseSync) {}
  static async open(input: LifecycleSourceOptions & { statePath: string; streamId: string }) {
    validateScope(input.scope); batchSize(input); requestTimeout(input);
    input = { ...input, scope: structuredClone(input.scope), ...(input.now ? { now: new Date(input.now) } : {}) };
    if (!isAbsolute(input.statePath) || !UUID.test(input.streamId)) fail('lifecycle_state_invalid');
    const opened = await sourceDatabase(input.sourcePath);
    try {
      const statePath = resolve(input.statePath);
      const existing = await lstat(statePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('lifecycle_state_invalid');
      if (existing && await realpath(statePath) === opened.canonicalPath) fail('lifecycle_state_is_source');
      const sourceStat = await lstat(opened.canonicalPath);
      if (existing && existing.dev === sourceStat.dev && existing.ino === sourceStat.ino) fail('lifecycle_state_is_source');
      await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
      const state = new DatabaseSync(statePath, { allowExtension: false });
      try {
        if (existing && state.prepare('PRAGMA application_id').get()?.application_id !== STATE_APPLICATION_ID) {
          fail('lifecycle_state_not_adapter');
        }
        await chmod(statePath, 0o600);
        state.exec('BEGIN IMMEDIATE');
        try {
        state.exec(`PRAGMA application_id = ${STATE_APPLICATION_ID};`);
        state.exec(`CREATE TABLE IF NOT EXISTS adapter_scope (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS adapter_cursor (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL, event_hash TEXT);
          CREATE TABLE IF NOT EXISTS adapter_events (event_id TEXT NOT NULL, revision INTEGER NOT NULL,
            event_hash TEXT NOT NULL, request_hash TEXT, state TEXT NOT NULL, observation TEXT,
            PRIMARY KEY(event_id, revision));
          CREATE TABLE IF NOT EXISTS adapter_lease (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL,
            pid INTEGER NOT NULL, host_hash TEXT NOT NULL);`);
        const digest = sha256(canonicalize({ streamId: input.streamId, source: sha256(opened.canonicalPath),
          scope: { ...input.scope, targets: [...input.scope.targets].sort((a, b) => a.endpointId.localeCompare(b.endpointId)) } }));
        const prior = state.prepare('SELECT digest FROM adapter_scope WHERE id=1').get();
        if (prior && prior.digest !== digest) fail('lifecycle_state_scope_conflict');
        state.prepare('INSERT OR IGNORE INTO adapter_scope VALUES (1, ?)').run(digest);
        state.exec('INSERT OR IGNORE INTO adapter_cursor VALUES (1, 0, NULL);');
        state.exec('COMMIT');
        } catch (error) { state.exec('ROLLBACK'); throw error; }
        return new SqliteLifecycleAdapter({ ...input, statePath }, opened.source, state);
      } catch (error) { state.close(); throw error; }
    } catch (error) { opened.source.close(); throw error; }
  }
  cursor() { return Number(this.state.prepare('SELECT sequence FROM adapter_cursor WHERE id=1').get()!.sequence); }
  #verifyConsumedHead() {
    const cursor = this.state.prepare('SELECT sequence, event_hash FROM adapter_cursor WHERE id=1').get()!;
    if (cursor.sequence === 0) return;
    try {
      const row = this.source.prepare(`SELECT CASE WHEN length(CAST(event_json AS BLOB)) <= 16384
        THEN event_json ELSE NULL END AS event_json FROM dharma_lifecycle_export_v1 WHERE sequence=?`).get(Number(cursor.sequence));
      if (!row || sha256(canonicalize(parseEvent(row.event_json as string | null, this.options.scope))) !== cursor.event_hash) {
        fail('lifecycle_consumed_history_changed');
      }
    } catch { fail('lifecycle_consumed_history_changed'); }
  }
  close() {
    if (this.#running) fail('lifecycle_adapter_busy');
    this.source.close(); this.state.close();
  }
  #transaction<T>(fn: () => T): T {
    this.state.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.state.exec('COMMIT'); return result; }
    catch (error) { this.state.exec('ROLLBACK'); throw error; }
  }
  async run(transport: LifecycleHandoffTransport) {
    if (transport.organizationId !== this.options.scope.organizationId) fail('lifecycle_transport_scope_mismatch');
    if (this.#running) fail('lifecycle_adapter_busy');
    const holder = randomUUID(); const hostHash = sha256(hostname());
    this.#transaction(() => {
      const lease = this.state.prepare('SELECT * FROM adapter_lease WHERE id=1').get();
      if (lease && (lease.host_hash !== hostHash || alive(Number(lease.pid)))) fail('lifecycle_adapter_busy');
      this.state.prepare('INSERT OR REPLACE INTO adapter_lease VALUES (1, ?, ?, ?)').run(holder, process.pid, hostHash);
    });
    this.#running = true;
    const processed: Array<{ sequence: number; eventId: string; state: 'dispatched' | 'duplicate' | 'expired'; observationHash: string | null }> = [];
    let currentSequence: number | null = null;
    try {
      this.#verifyConsumedHead();
      for (const row of readRows(this.source, this.cursor(), batchSize(this.options))) {
        currentSequence = row.sequence;
        const event = parseEvent(row.event_json, this.options.scope);
        const planned = await prepare(event, this.options);
        const prior = this.state.prepare('SELECT * FROM adapter_events WHERE event_id=? AND revision=?').get(event.eventId, event.revision);
        if (prior && (prior.event_hash !== planned.eventHash
          || (planned.state === 'planned' && prior.request_hash !== planned.requestHash))) fail('lifecycle_projection_conflict');
        if (prior?.state === 'pending' && planned.state === 'expired') fail('lifecycle_pending_expired');
        if (prior?.state === 'dispatched' || prior?.state === 'expired') {
          this.state.prepare('UPDATE adapter_cursor SET sequence=?, event_hash=? WHERE id=1').run(row.sequence, planned.eventHash);
          processed.push({ sequence: row.sequence, eventId: event.eventId, state: 'duplicate', observationHash: null });
          continue;
        }
        // Pin immutable hashes before network dispatch; never replay changed source bytes after a lost response.
        this.#transaction(() => {
          this.state.prepare('INSERT OR IGNORE INTO adapter_events VALUES (?, ?, ?, ?, ?, NULL)')
            .run(event.eventId, event.revision, planned.eventHash,
              planned.state === 'planned' ? planned.requestHash : null, planned.state === 'expired' ? 'expired' : 'pending');
        });
        let observed = null;
        if (planned.state === 'planned') {
          let response;
          const controller = new AbortController();
          let timer: NodeJS.Timeout | undefined;
          try { response = await Promise.race([
            transport.dispatchHandoff(planned.handoff, { idempotencyKey: planned.idempotencyKey, signal: controller.signal }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => {
              controller.abort(); reject(new LifecycleAdapterError('lifecycle_transport_unavailable'));
            }, requestTimeout(this.options)); }),
          ]); }
          catch { fail('lifecycle_transport_unavailable'); }
          finally { if (timer) clearTimeout(timer); }
          observed = receipt(response, event, planned.eventHash, planned.requestHash);
        }
        this.#transaction(() => {
          this.state.prepare('UPDATE adapter_events SET state=?, observation=? WHERE event_id=? AND revision=?')
            .run(observed ? 'dispatched' : 'expired', observed ? JSON.stringify(observed) : null, event.eventId, event.revision);
          this.state.prepare('UPDATE adapter_cursor SET sequence=?, event_hash=? WHERE id=1').run(row.sequence, planned.eventHash);
        });
        processed.push({ sequence: row.sequence, eventId: event.eventId, state: observed ? 'dispatched' : 'expired',
          observationHash: observed?.observationHash ?? null });
      }
      return { state: 'drained' as const, cursor: this.cursor(), processed, executionVerified: false as const };
    } catch (error) {
      return { state: 'blocked' as const, cursor: this.cursor(), processed, sequence: currentSequence,
        code: error instanceof LifecycleAdapterError ? error.code : 'lifecycle_adapter_failure', executionVerified: false as const };
    } finally {
      this.state.prepare('DELETE FROM adapter_lease WHERE id=1 AND holder=?').run(holder);
      this.#running = false;
    }
  }
}
