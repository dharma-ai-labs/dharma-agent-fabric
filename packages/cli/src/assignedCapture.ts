import { posix, resolve, win32 } from 'node:path';
import { types } from 'node:util';
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
  const selection = await selectCapture(context, undefined, assignmentId);
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
  const current = snapshotData(binding, 'capture_assignment_binding_mismatch') as AssignedCaptureBinding;
  if (!current || current.active !== true || current.consentActive !== true
    || current.organizationId !== value.organizationId
    || targetFields.some(key => current.target?.[key] !== value.target[key])
    || policyFields.some(key => current.policy?.[key] !== value.policy[key])) {
    refuse('capture_assignment_binding_mismatch');
  }
  if (current.approvedAssignmentHash !== value.integrity.sha256) refuse('capture_assignment_integrity_mismatch');
  if (!Array.isArray(current.allowedSourceLocators)
    || !current.allowedSourceLocators.includes(value.source.locator)) refuse('capture_assignment_source_not_allowed');
}

const assignmentDataLimits = {nodes: 512, depth: 8, arrayLength: 128};
const readerDataLimits = {nodes: 1_000_000, depth: 64, arrayLength: 100_000};

function snapshotData(value: unknown, code: string, limits = readerDataLimits): unknown {
  const active = new Set<object>(), finished = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  try {
    while (stack.length) {
      const item = stack.pop()!, current = item.value;
      if (item.exit) { active.delete(current as object); finished.add(current as object); continue; }
      if (++nodes > limits.nodes || item.depth > limits.depth) refuse(code);
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
      if (typeof current === 'number' && Number.isFinite(current)) continue;
      if (typeof current !== 'object' || types.isProxy(current) || active.has(current)) refuse(code);
      if (finished.has(current)) refuse(code);
      const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
      if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
        refuse(code);
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length > limits.nodes - nodes + 1) refuse(code);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (array && (descriptors.length!.value > limits.arrayLength
        || keys.length !== descriptors.length!.value + 1)) refuse(code);
      active.add(current); stack.push({ value: current, depth: item.depth, exit: true });
      for (const key of keys) {
        if (typeof key !== 'string') refuse(code);
        const descriptor = descriptors[key]!;
        if ('get' in descriptor || 'set' in descriptor) refuse(code);
        if (array && key === 'length') continue;
        if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length!.value)) refuse(code);
        if (!descriptor.enumerable) refuse(code);
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
    // Only JSON-tree data reaches this copy. Shared references are refused so
    // later serialization cannot amplify a small graph exponentially.
    return structuredClone(value);
  } catch { return refuse(code); }
}

function captureControls(input: unknown, command: boolean) {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) refuse('capture_assignment_invalid');
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !['assignment', 'binding', 'now', ...(command ? ['reader'] : [])].includes(key)) {
      refuse('capture_assignment_invalid');
    }
    // The command reader slot is deliberately resolved only after authorization.
    if (key !== 'reader' && (!fields[key]!.enumerable || !Object.hasOwn(fields[key]!, 'value'))) {
      refuse('capture_assignment_invalid');
    }
  }
  if (!fields.assignment || !fields.binding) refuse('capture_assignment_invalid');
  const now = fields.now?.value ?? Date.now;
  if (typeof now !== 'function' || types.isProxy(now)) refuse('capture_assignment_invalid');
  const binding = fields.binding.value as AssignedCaptureBinding;
  return {assignment: snapshotData(fields.assignment.value, 'capture_assignment_invalid', assignmentDataLimits),
    binding,
    now: () => {try {return Reflect.apply(now, undefined, []) as number;} catch {return refuse('capture_assignment_window_invalid');}},
    requireBindingReference() {
      const live = Object.getOwnPropertyDescriptor(input, 'binding');
      if (!live?.enumerable || !Object.hasOwn(live, 'value') || live.value !== binding) {
        refuse('capture_assignment_binding_mismatch');
      }
    }};
}

function exactReaderMethod(reader: unknown): ExactSessionReader['readExactSession'] {
  let owner = reader;
  for (let depth = 0; depth < 32 && owner !== null; depth++) {
    if (!owner || typeof owner !== 'object' || types.isProxy(owner)) refuse('capture_source_unavailable');
    const method = Object.getOwnPropertyDescriptor(owner, 'readExactSession');
    if (method) {
      if (!Object.hasOwn(method, 'value') || typeof method.value !== 'function' || types.isProxy(method.value)) {
        refuse('capture_source_unavailable');
      }
      return method.value as ExactSessionReader['readExactSession'];
    }
    owner = Object.getPrototypeOf(owner);
  }
  return refuse('capture_source_unavailable');
}

export async function selectAssignedCapture(input: {
  assignment: unknown; binding: AssignedCaptureBinding; now?: () => number;
}, reader?: ExactSessionReader): Promise<AssignedCaptureSelection> {
  return selectCapture(input, reader);
}

async function selectCapture(input: {
  assignment: unknown; binding: AssignedCaptureBinding; now?: () => number;
}, reader?: ExactSessionReader, commandAssignmentId?: string): Promise<AssignedCaptureSelection> {
  const controls = captureControls(input, commandAssignmentId !== undefined);
  const candidate = controls.assignment;
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
  const now = controls.now;
  const requireBinding = () => {controls.requireBindingReference(); assertBinding(assignment, controls.binding);};
  assertWindow(assignment, now());
  requireBinding();
  if (commandAssignmentId !== undefined) {
    if (assignment.assignmentId !== commandAssignmentId) refuse('capture_source_unavailable');
    const slot = Object.getOwnPropertyDescriptor(input, 'reader');
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) refuse('capture_source_unavailable');
    reader = slot.value as ExactSessionReader;
  }
  const read = exactReaderMethod(reader);

  // Do not delegate to capture(), broad discover(), or pending-retention sync.
  // Only an independently qualified, exact-source owner bridge may fill this port.
  const request = Object.freeze({ assignmentId: assignment.assignmentId, organizationId: assignment.organizationId,
    target: Object.freeze({ ...assignment.target }), source: Object.freeze({ ...assignment.source }) });
  let response: unknown;
  try { response = await Reflect.apply(read, reader, [request]); }
  catch { return refuse('capture_source_unavailable'); }
  const captured = snapshotData(response, 'capture_selected_source_mismatch') as Awaited<ReturnType<ExactSessionReader['readExactSession']>>;
  assertWindow(assignment, now());
  requireBinding();
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
  requireBinding();
  return { schema: 'dharma.assigned-capture-selection/v1', assignmentId: assignment.assignmentId,
    organizationId: assignment.organizationId, assignmentHash: digest,
    provider: assignment.target.provider, sessionId: assignment.target.sessionId,
    workspaceId: assignment.target.workspaceId, sourceClass: assignment.source.sourceClass,
    sourceSha256: captured.sourceSha256, sourceLocatorHash: sha256(assignment.source.locator),
    coverage: session.coverage, recordCount: session.records.length, bindingMatched: true,
    syncAllowed: false, analysisAllowed: false, learningAdmitted: false, nativeExecutionVerified: false, persisted: false };
}
