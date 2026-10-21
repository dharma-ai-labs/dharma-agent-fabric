import { posix, resolve, win32 } from 'node:path';
import { canonicalize, sha256, validateContract, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import type { ProviderSession } from '@dharma-ai-labs/agent-fabric-provider-adapters';

export interface CaptureTarget {
  accountId: string; membershipId: string; hostId: string; deviceId: string;
  workspaceId: string; endpointId: string; repositoryFingerprint: string;
  workspacePath: string; provider: ProviderId; sessionId: string;
}
export interface CaptureAssignment {
  schema: 'dharma.capture-assignment/v1'; assignmentId: string; organizationId: string;
  createdAt: string; expiresAt: string; target: CaptureTarget;
  source: { sourceClass: 'provider_discovery' | 'explicit_import'; locator: string; sha256: string;
    maximumBytes: number; maximumRecordBytes: number; maximumRecords: number; since: string; until: string };
  policy: { sourceRevision: string; sourceHash: string; disclosureRevision: string; disclosureHash: string;
    consentRevision: string; retentionDays: number };
  effects: { sync: false; analysis: false; learning: false; maximumModelCostCents: 0 };
  integrity: { sha256: string };
}
export interface AssignedCaptureBinding {
  organizationId: string; target: CaptureTarget; policy: CaptureAssignment['policy'];
  approvedAssignmentHash: string; active: boolean; consentActive: boolean;
  allowedSourceLocators: readonly string[];
}
export interface ExactSessionReadRequest {
  assignmentId: string; organizationId: string; target: CaptureTarget;
  source: CaptureAssignment['source'];
}
export interface ExactSessionReader {
  readExactSession(request: ExactSessionReadRequest): Promise<{
    session: ProviderSession; sourceSha256: string; sourceBytes: number;
  }>;
}
export interface AssignedCaptureSelection {
  schema: 'dharma.assigned-capture-selection/v1'; assignmentId: string; organizationId: string;
  assignmentHash: string; provider: ProviderId; sessionId: string; workspaceId: string;
  sourceClass: CaptureAssignment['source']['sourceClass']; sourceSha256: string;
  sourceLocatorHash: string; coverage: ProviderSession['coverage']; recordCount: number;
  bindingMatched: true; syncAllowed: false; analysisAllowed: false; learningAdmitted: false;
  nativeExecutionVerified: false; persisted: false;
}
export interface AssignedCaptureCommandContext {
  assignment: unknown;
  binding: AssignedCaptureBinding;
  reader?: ExactSessionReader;
  now?: () => number;
}

export async function runAssignedCaptureCommand(input: {
  positional: readonly string[];
  flags: ReadonlyMap<string, string | boolean>;
  repeated: ReadonlyMap<string, readonly (string | boolean)[]>;
}, context?: AssignedCaptureCommandContext): Promise<{ ok: true; selection: AssignedCaptureSelection }> {
  const { positional, flags, repeated } = input;
  const capture = positional.length === 1 && positional[0] === 'capture'
    || positional.length === 2 && positional[0] === 'evidence' && positional[1] === 'capture';
  const assignmentId = flags.get('assignment-id');
  if (!capture || typeof assignmentId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(assignmentId)
    || [...flags.keys()].some(key => key !== 'assignment-id' && key !== 'json')
    || flags.has('json') && flags.get('json') !== true
    || [...repeated.values()].some(values => values.length !== 1)) {
    refuse('capture_assignment_command_invalid');
  }
  if (!context) refuse('capture_source_unavailable');
  const selection = await selectAssignedCapture({ assignment: context.assignment, binding: context.binding,
    ...(context.now ? { now: context.now } : {}) }, {
    async readExactSession(request) {
      // Resolve the trusted reader only after the assignment and binding guards.
      if (request.assignmentId !== assignmentId) refuse('capture_source_unavailable');
      const reader = context.reader;
      const read = reader?.readExactSession;
      if (typeof read !== 'function') refuse('capture_source_unavailable');
      return Reflect.apply(read, reader, [request]);
    },
  });
  return { ok: true, selection };
}

const schemaId = 'https://schemas.dharma-ai.io/capture-assignment/v1';
const targetFields: ReadonlyArray<keyof CaptureTarget> = [
  'accountId', 'membershipId', 'hostId', 'deviceId', 'workspaceId', 'endpointId',
  'repositoryFingerprint', 'workspacePath', 'provider', 'sessionId',
];
const policyFields: ReadonlyArray<keyof CaptureAssignment['policy']> = [
  'sourceRevision', 'sourceHash', 'disclosureRevision', 'disclosureHash', 'consentRevision', 'retentionDays',
];
function refuse(code: string): never { throw new Error(code); }
function canonicalAbsolutePath(value: string): boolean {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return win32.normalize(value) === value && !value.endsWith('\\');
  return value.startsWith('/') && value !== '/' && posix.normalize(value) === value && !value.endsWith('/');
}
function assignmentHash(value: CaptureAssignment): string {
  const { integrity: _, ...body } = value;
  return sha256(canonicalize(body));
}
function assertWindow(value: CaptureAssignment, now: number) {
  const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt);
  const since = Date.parse(value.source.since), until = Date.parse(value.source.until);
  if (![created, expires, since, until, now].every(Number.isFinite)
    || created > now || expires <= now || expires <= created || expires - created > 86_400_000
    || since > until || until > now) refuse('capture_assignment_window_invalid');
}
function assertBinding(value: CaptureAssignment, binding: AssignedCaptureBinding) {
  if (!binding || binding.active !== true || binding.consentActive !== true
    || binding.organizationId !== value.organizationId
    || targetFields.some(key => binding.target?.[key] !== value.target[key])
    || policyFields.some(key => binding.policy?.[key] !== value.policy[key])) {
    refuse('capture_assignment_binding_mismatch');
  }
  if (binding.approvedAssignmentHash !== value.integrity.sha256) refuse('capture_assignment_integrity_mismatch');
  if (!Array.isArray(binding.allowedSourceLocators)
    || !binding.allowedSourceLocators.includes(value.source.locator)) refuse('capture_assignment_source_not_allowed');
}

function snapshotReaderData(value: unknown): unknown {
  const active = new Set<object>(), finished = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  try {
    while (stack.length) {
      const item = stack.pop()!, current = item.value;
      if (item.exit) { active.delete(current as object); finished.add(current as object); continue; }
      if (++nodes > 1_000_000 || item.depth > 64) refuse('capture_selected_source_mismatch');
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
      if (typeof current === 'number' && Number.isFinite(current)) continue;
      if (typeof current !== 'object' || active.has(current)) refuse('capture_selected_source_mismatch');
      if (finished.has(current)) refuse('capture_selected_source_mismatch');
      const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
      if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
        refuse('capture_selected_source_mismatch');
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (array && descriptors.length!.value > 100_000) refuse('capture_selected_source_mismatch');
      active.add(current); stack.push({ value: current, depth: item.depth, exit: true });
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') refuse('capture_selected_source_mismatch');
        const descriptor = descriptors[key]!;
        if ('get' in descriptor || 'set' in descriptor) refuse('capture_selected_source_mismatch');
        if (array && key === 'length') continue;
        if (!descriptor.enumerable) refuse('capture_selected_source_mismatch');
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
    // Only JSON-tree data reaches this copy. Shared references are refused so
    // later serialization cannot amplify a small graph exponentially.
    return structuredClone(value);
  } catch { return refuse('capture_selected_source_mismatch'); }
}

export async function selectAssignedCapture(input: {
  assignment: unknown; binding: AssignedCaptureBinding; now?: () => number;
}, reader?: ExactSessionReader): Promise<AssignedCaptureSelection> {
  let candidate: unknown;
  try { candidate = structuredClone(input.assignment); }
  catch { return refuse('capture_assignment_invalid'); }
  let valid: boolean;
  try {
    valid = (await validateContract(resolve(import.meta.dirname, 'schemas'), schemaId, candidate)).ok;
  } catch { return refuse('capture_assignment_schema_unavailable'); }
  if (!valid) refuse('capture_assignment_invalid');
  const assignment = candidate as CaptureAssignment;
  if (!canonicalAbsolutePath(assignment.target.workspacePath) || !canonicalAbsolutePath(assignment.source.locator)
    || assignment.source.maximumRecordBytes > assignment.source.maximumBytes) refuse('capture_assignment_invalid');
  const digest = assignmentHash(assignment);
  if (digest !== assignment.integrity.sha256) refuse('capture_assignment_integrity_mismatch');
  const now = input.now ?? Date.now;
  assertWindow(assignment, now());
  assertBinding(assignment, input.binding);
  if (!reader || typeof reader.readExactSession !== 'function') refuse('capture_source_unavailable');

  // Do not delegate to capture(), broad discover(), or pending-retention sync.
  // Only an independently qualified, exact-source owner bridge may fill this port.
  const request = Object.freeze({ assignmentId: assignment.assignmentId, organizationId: assignment.organizationId,
    target: Object.freeze({ ...assignment.target }), source: Object.freeze({ ...assignment.source }) });
  let response: unknown;
  try { response = await reader.readExactSession(request); }
  catch { return refuse('capture_source_unavailable'); }
  const captured = snapshotReaderData(response) as Awaited<ReturnType<ExactSessionReader['readExactSession']>>;
  assertWindow(assignment, now());
  assertBinding(assignment, input.binding);
  const session = captured?.session;
  const since = Date.parse(assignment.source.since), until = Date.parse(assignment.source.until);
  const start = Date.parse(session?.startedAt), end = Date.parse(session?.endedAt);
  if (!session || session.provider !== assignment.target.provider || session.sessionId !== assignment.target.sessionId
    || session.workspace !== assignment.target.workspacePath || session.sourcePath !== assignment.source.locator
    || captured.sourceSha256 !== assignment.source.sha256
    || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start < since || end > until
    || !Array.isArray(session.records) || session.records.length === 0) refuse('capture_selected_source_mismatch');
  if (!['observed', 'partial'].includes(session.coverage)) refuse('capture_source_unavailable');
  if (!Number.isSafeInteger(captured.sourceBytes) || captured.sourceBytes < 1
    || captured.sourceBytes > assignment.source.maximumBytes
    || session.records.length > assignment.source.maximumRecords) refuse('capture_selected_source_bound_exceeded');
  let recordBytes = 0;
  for (const record of session.records) {
    const timestamp = Date.parse(record?.timestamp ?? '');
    if (!record || record.workspace !== assignment.target.workspacePath
      || record.sourcePath !== assignment.source.locator
      || !Number.isFinite(timestamp) || timestamp < start || timestamp > end) refuse('capture_selected_source_mismatch');
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(record)); }
    catch { return refuse('capture_selected_source_bound_exceeded'); }
    recordBytes += bytes;
    if (bytes > assignment.source.maximumRecordBytes || recordBytes > assignment.source.maximumBytes) {
      refuse('capture_selected_source_bound_exceeded');
    }
  }
  assertWindow(assignment, now());
  assertBinding(assignment, input.binding);
  return { schema: 'dharma.assigned-capture-selection/v1', assignmentId: assignment.assignmentId,
    organizationId: assignment.organizationId, assignmentHash: digest,
    provider: assignment.target.provider, sessionId: assignment.target.sessionId,
    workspaceId: assignment.target.workspaceId, sourceClass: assignment.source.sourceClass,
    sourceSha256: captured.sourceSha256, sourceLocatorHash: sha256(assignment.source.locator),
    coverage: session.coverage, recordCount: session.records.length, bindingMatched: true,
    syncAllowed: false, analysisAllowed: false, learningAdmitted: false, nativeExecutionVerified: false, persisted: false };
}
