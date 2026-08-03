import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ErrorObject } from 'ajv';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  addSchema(schema: unknown): void;
  getSchema(id: string): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null } | undefined;
};
const addFormats = require('ajv-formats').default as (ajv: unknown) => void;

export type EvidenceState =
  | 'observed'
  | 'partial'
  | 'unavailable'
  | 'excluded'
  | 'redacted'
  | 'out_of_window'
  | 'not_supported';

export interface ProtocolEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  schema: 'dharma.protocol-envelope/v1';
  messageId: string;
  organizationId: string;
  deviceId: string;
  sessionId: string;
  sentAt: string;
  expiresAt: string;
  sequence: number;
  nonce: string;
  type: string;
  payload: T;
  signature: string;
}

export interface RegisteredCommand {
  commandId: string;
  argv: string[];
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface ProviderCapability {
  provider: string;
  version: string | null;
  evidence: 'available' | 'partial' | 'unavailable';
  configuredAssets: 'available' | 'partial' | 'unavailable';
  taskExecution: 'available' | 'partial' | 'unavailable';
  sessionContinuation: 'available' | 'partial' | 'unavailable';
  skillInstall: 'available' | 'partial' | 'unavailable';
  activation: 'next_task' | 'next_session' | 'host_restart' | 'immediate_safe_reload' | 'unavailable';
  usageEvidence: 'available' | 'partial' | 'unavailable';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function envelopeSigningPayload(envelope: Omit<ProtocolEnvelope, 'signature'>): Buffer {
  return Buffer.from(canonicalize(envelope), 'utf8');
}

export function signEnvelope(
  envelope: Omit<ProtocolEnvelope, 'signature'>,
  privateKey: KeyObject,
): ProtocolEnvelope {
  return {
    ...envelope,
    signature: sign(null, envelopeSigningPayload(envelope), privateKey).toString('base64url'),
  };
}

export function verifyEnvelope(
  envelope: ProtocolEnvelope,
  publicKey: KeyObject,
  now = new Date(),
): { ok: true } | { ok: false; reason: 'expired' | 'not_yet_valid' | 'bad_signature' } {
  const sentAt = Date.parse(envelope.sentAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (expiresAt <= now.getTime()) return { ok: false, reason: 'expired' };
  if (sentAt > now.getTime() + 5 * 60_000) return { ok: false, reason: 'not_yet_valid' };
  const { signature, ...unsigned } = envelope;
  const valid = verify(
    null,
    envelopeSigningPayload(unsigned),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

export async function validateContract(
  schemaDirectory: string,
  schemaId: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; errors: ErrorObject[] }> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of (await readdir(schemaDirectory)).filter((item) => item.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(await readFile(resolve(schemaDirectory, name), 'utf8')));
  }
  const validator = ajv.getSchema(schemaId);
  if (!validator) throw new Error(`Unknown contract schema: ${schemaId}`);
  return validator(value) ? { ok: true } : { ok: false, errors: [...(validator.errors ?? [])] };
}
