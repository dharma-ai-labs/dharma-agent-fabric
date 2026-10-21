import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { ProviderExecutionResult, ProviderProcessRunner } from './index.js';

export interface ProviderExecutionQualification {
  organizationId: string;
  taskId: string;
  inputSha256: string;
  candidateSha256: string;
  oracleReceiptSha256: string;
  fileRootsSha256: string | null;
  skillRootsSha256: string | null;
  settingsSha256: string | null;
  contextSha256: string | null;
}

const digestFields = ['inputSha256', 'candidateSha256', 'oracleReceiptSha256'] as const;
const nullableFields = ['fileRootsSha256', 'skillRootsSha256', 'settingsSha256', 'contextSha256'] as const;
const fields = ['organizationId', 'taskId', ...digestFields, ...nullableFields];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const unverified = Object.freeze([
  'effective_model_and_settings', 'effective_file_roots', 'effective_skill_roots',
  'tool_policy_enforcement', 'fresh_context', 'independent_oracle_custody',
] as const);

export function snapshotProviderExecutionQualification(value: unknown): ProviderExecutionQualification {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) throw new Error();
    const snapshot: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error();
      snapshot[field] = descriptor.value;
    }
    if (typeof snapshot.organizationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(snapshot.organizationId)
      || typeof snapshot.taskId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snapshot.taskId)) throw new Error();
    for (const field of [...digestFields, ...nullableFields]) {
      const item = snapshot[field];
      if (item === null && (nullableFields as readonly string[]).includes(field)) continue;
      if (typeof item !== 'string' || !digestPattern.test(item)) throw new Error();
    }
    return Object.freeze(snapshot) as unknown as ProviderExecutionQualification;
  } catch {
    throw new Error('Provider execution qualification is invalid.');
  }
}

export interface ProviderExecutionQualificationReceipt {
  schema: 'dharma.provider-execution-qualification/v1';
  receiptId: string;
  startedAt: string;
  observedAt: string;
  declared: ProviderExecutionQualification;
  invocation: {
    provider: ProviderExecutionResult['provider'];
    runner: 'default_process' | 'injected';
    argvSha256: string;
    stdinSha256: string;
    workspaceSha256: string;
    allowedCommandArgvSha256: string;
    environmentOverrideSha256: string;
    configuredModelSha256: string | null;
    timeoutMs: number;
    allowWrites: boolean;
  };
  outcome: Pick<ProviderExecutionResult, 'exitCode' | 'signal' | 'timedOut' | 'stdoutSha256' | 'stderrSha256' | 'failureCategory'>;
  unverified: typeof unverified;
}

const digestSchema = z.string().regex(digestPattern);
const timeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const reportSchema = z.object({
  schema: z.literal('dharma.provider-execution-qualification/v1'),
  receiptId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  startedAt: timeSchema, observedAt: timeSchema,
  declared: z.unknown().transform((value) => snapshotProviderExecutionQualification(value)),
  invocation: z.object({
    provider: z.enum(['codex', 'claude', 'agy', 'hermes']), runner: z.enum(['default_process', 'injected']),
    argvSha256: digestSchema, stdinSha256: digestSchema, workspaceSha256: digestSchema,
    allowedCommandArgvSha256: digestSchema, environmentOverrideSha256: digestSchema,
    configuredModelSha256: digestSchema.nullable(), timeoutMs: z.number().min(1_000).max(3_600_000),
    allowWrites: z.boolean(),
  }).strict(),
  outcome: z.object({
    exitCode: z.number().int().nullable(), signal: z.string().max(32).regex(/^SIG[A-Z0-9]+$/).nullable(),
    timedOut: z.boolean(), stdoutSha256: digestSchema, stderrSha256: digestSchema,
    failureCategory: z.enum(['quota', 'authentication', 'model_unavailable', 'transport', 'timeout', 'unknown']).nullable(),
  }).strict(),
  unverified: z.array(z.string()).length(unverified.length)
    .refine((items) => items.every((item, index) => item === unverified[index])),
}).strict();

export function reportedProviderExecutionQualification(
  result: ProviderExecutionResult,
  declared: ProviderExecutionQualification,
  expectedProvider: ProviderExecutionResult['provider'],
): ProviderExecutionQualificationReceipt | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, 'qualificationReceipt');
    if (!descriptor || !('value' in descriptor)) return null;
    let nodes = 0;
    const copy = (value: unknown, depth = 0): unknown => {
      if (++nodes > 128 || depth > 4) throw new Error();
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'string' && value.length <= 200) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (!value || typeof value !== 'object') throw new Error();
      const array = Array.isArray(value);
      if (array ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > 20 || keys.some((key) => typeof key !== 'string')) throw new Error();
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isInteger(length) || length > 6 || keys.length !== length + 1) throw new Error();
        return Array.from({ length }, (_, index) => {
          const item = descriptors[String(index)];
          if (!item || !('value' in item) || !item.enumerable) throw new Error();
          return copy(item.value, depth + 1);
        });
      }
      const record: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
        const item = descriptors[key]!;
        if (!('value' in item) || !item.enumerable) throw new Error();
        record[key] = copy(item.value, depth + 1);
      }
      return record;
    };
    const parsed = reportSchema.safeParse(copy(descriptor.value));
    if (!parsed.success) return null;
    const receipt = parsed.data;
    if (JSON.stringify(receipt.declared) !== JSON.stringify(declared)
      || result.provider !== expectedProvider || receipt.invocation.provider !== expectedProvider
      || receipt.outcome.exitCode !== result.exitCode || receipt.outcome.signal !== result.signal
      || receipt.outcome.timedOut !== result.timedOut
      || receipt.outcome.stdoutSha256 !== result.stdoutSha256 || receipt.outcome.stderrSha256 !== result.stderrSha256
      || receipt.outcome.failureCategory !== (result.failureCategory ?? null)) return null;
    return receipt as unknown as ProviderExecutionQualificationReceipt;
  } catch {
    return null;
  }
}

export function prepareProviderExecutionQualification(
  declared: ProviderExecutionQualification,
  call: Parameters<ProviderProcessRunner>[0],
  options: { provider: ProviderExecutionResult['provider']; injected: boolean; allowedCommandArgv: string[][]; allowWrites: boolean },
): (result: ProviderExecutionResult) => ProviderExecutionQualificationReceipt {
  const modelIndex = call.argv.indexOf('--model');
  const prepared = {
    schema: 'dharma.provider-execution-qualification/v1' as const,
    receiptId: randomUUID(), startedAt: new Date().toISOString(), declared,
    invocation: {
      provider: options.provider, runner: options.injected ? 'injected' as const : 'default_process' as const,
      argvSha256: hash(JSON.stringify(call.argv)), stdinSha256: hash(call.stdin),
      workspaceSha256: hash(call.cwd), allowedCommandArgvSha256: hash(JSON.stringify(options.allowedCommandArgv)),
      environmentOverrideSha256: hash(JSON.stringify(call.environment || {})),
      configuredModelSha256: modelIndex >= 0 ? hash(call.argv[modelIndex + 1]!) : null,
      timeoutMs: call.timeoutMs, allowWrites: options.allowWrites,
    },
  };
  // These are adapter-boundary observations, not provider enforcement or custody attestations.
  return (result) => ({
    ...prepared, observedAt: new Date().toISOString(),
    outcome: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
      failureCategory: result.failureCategory ?? null },
    unverified,
  });
}
