import { randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  SESSION_NAME_PATTERN,
  validateProviderSessionRegistrationV2Contract,
  validateProviderSessionRegistrationV2ReceiptContract,
  type ProviderSessionRegistrationV2,
  type ProviderSessionRegistrationV2Receipt,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { isUncertainSessionTransportFailure, SESSION_MESSAGE_ROUTES } from './sessionMessageClient.js';

/** The device-signed client surface (`AgentFabricClient.signedGet/signedPost`). */
export interface SessionMessageTransport {
  signedGet(route: string): Promise<Record<string, unknown>>;
  signedPost(route: string, body: unknown): Promise<Record<string, unknown>>;
}
export interface SessionMessagingDevice { organizationId: string; deviceId: string; privateKey: KeyObject }
/** Everything the session commands read from the process; each command reads the device and
 * opens the signed transport only after its options and consent are checked. */
export interface SessionMessagingHost {
  home: string; cwd: string; env: Record<string, string | undefined>; now(): Date;
  device(): Promise<SessionMessagingDevice>; transport(): Promise<SessionMessageTransport>;
}
/** The local half of a delivery-only binding. The thread id or Claude session id lives only here;
 * the platform holds the name, the binding id and the owner. */
export interface LocalSessionAttachment {
  schema: 'dharma.local-session-attachment/v1'; name: string; provider: 'codex' | 'claude';
  delivery: 'codex_queue' | 'claude_hook'; bindingId: string; organizationId: string; deviceId: string;
  membershipId: string | null; revision: number; pending: boolean; threadId?: string; claudeSessionId?: string;
  cwd?: string; updatedAt: string;
}
export interface ClaudeSessionStartRecord {
  schema: 'dharma.claude-session-start/v1'; sessionId: string; cwd: string; at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Set by the plugin's SessionStart hook through CLAUDE_ENV_FILE, so a Bash call knows its own session. */
export const CLAUDE_SESSION_ENV = 'DHARMA_CLAUDE_SESSION_ID';

export function sessionStatePath(home: string, ...parts: string[]): string {
  return resolve(home, 'session-messages', ...parts);
}

/** Atomic private JSON write: temp file in the same directory, then rename. */
export async function writeSessionStateFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function readSessionStateFile<T>(path: string): Promise<T | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as T;
}

function attachmentPath(home: string, name: string) {
  if (!SESSION_NAME_PATTERN.test(name)) throw new Error('session_name_invalid');
  return sessionStatePath(home, 'attachments', `${name}.json`);
}

export async function readSessionAttachment(home: string, name: string): Promise<LocalSessionAttachment | null> {
  const value = await readSessionStateFile<LocalSessionAttachment>(attachmentPath(home, name));
  if (value && (value.schema !== 'dharma.local-session-attachment/v1' || value.name !== name)) {
    throw new Error('session_attachment_record_invalid');
  }
  return value;
}

/** Completed local attachments (not ones still waiting for their attach receipt). */
export async function listSessionAttachments(home: string): Promise<LocalSessionAttachment[]> {
  let entries: string[];
  try { entries = await readdir(sessionStatePath(home, 'attachments')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names = entries.filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -'.json'.length))
    .filter(name => SESSION_NAME_PATTERN.test(name)).sort();
  const records = await Promise.all(names.map(name => readSessionAttachment(home, name)));
  return records.filter((record): record is LocalSessionAttachment => record !== null && !record.pending);
}

/** Written by the plugin's SessionStart hook: the session id and cwd, on this device only. */
export async function recordClaudeSessionStart(home: string, record: { sessionId: string; cwd: string; at: string }) {
  if (!CLAUDE_SESSION_ID.test(record.sessionId) || typeof record.cwd !== 'string' || !record.cwd) {
    throw new Error('claude_session_start_invalid');
  }
  const value: ClaudeSessionStartRecord = { schema: 'dharma.claude-session-start/v1', sessionId: record.sessionId,
    cwd: record.cwd, at: record.at };
  await writeSessionStateFile(sessionStatePath(home, 'claude-sessions', `${record.sessionId}.json`), value);
  return value;
}

export async function readClaudeSessionStart(home: string, sessionId: string): Promise<ClaudeSessionStartRecord | null> {
  if (!CLAUDE_SESSION_ID.test(sessionId)) return null;
  const value = await readSessionStateFile<ClaudeSessionStartRecord>(sessionStatePath(home, 'claude-sessions', `${sessionId}.json`));
  return value?.schema === 'dharma.claude-session-start/v1' && value.sessionId === sessionId ? value : null;
}

async function currentClaudeSession(host: SessionMessagingHost): Promise<ClaudeSessionStartRecord> {
  const named = host.env[CLAUDE_SESSION_ENV];
  if (named) {
    const record = await readClaudeSessionStart(host.home, named);
    if (!record) throw new Error('claude_current_session_unavailable');
    return record;
  }
  let entries: string[] = [];
  try { entries = await readdir(sessionStatePath(host.home, 'claude-sessions')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const records = (await Promise.all(entries.filter(entry => entry.endsWith('.json'))
    .map(entry => readClaudeSessionStart(host.home, entry.slice(0, -'.json'.length)))))
    .filter((record): record is ClaudeSessionStartRecord => record !== null && resolve(record.cwd) === resolve(host.cwd));
  if (records.length === 0) throw new Error('claude_current_session_unavailable');
  if (records.length > 1) throw new Error('claude_current_session_ambiguous');
  return records[0]!;
}

/** Exact option set: unknown keys, valued switches and empty values all throw `error`. */
export function assertSessionFlags(flags: Map<string, string | boolean>, allowed: string[], booleans: string[], error: string) {
  for (const [key, value] of flags) {
    if (!allowed.includes(key)) throw new Error(error);
    if (booleans.includes(key) ? value !== true : typeof value !== 'string' || value.length === 0) throw new Error(error);
  }
}

function attachOptions(flags: Map<string, string | boolean>) {
  const invalid = 'session_attach_options_invalid';
  assertSessionFlags(flags, ['provider', 'thread', 'current', 'name', 'yes', 'dry-run', 'json'], ['current', 'yes', 'dry-run', 'json'], invalid);
  const provider = flags.get('provider');
  const name = String(flags.get('name') ?? '');
  if (!SESSION_NAME_PATTERN.test(name) || flags.has('yes') && flags.has('dry-run')) throw new Error(invalid);
  if (provider === 'codex') {
    const thread = flags.get('thread');
    if (flags.has('current') || typeof thread !== 'string' || !UUID.test(thread)) throw new Error(invalid);
    return { name, provider, delivery: 'codex_queue', threadId: thread.toLowerCase() } as const;
  }
  if (provider === 'claude') {
    if (flags.has('thread') || flags.get('current') !== true) throw new Error(invalid);
    return { name, provider, delivery: 'claude_hook' } as const;
  }
  throw new Error(invalid);
}

function consentText(organizationId: string | null) {
  return `Any active member of ${organizationId ?? 'your organization'} can message this session. `
    + 'Messages arrive as untrusted text; your own instructions and permissions still apply.';
}

function receiptMatches(receipt: unknown, request: ProviderSessionRegistrationV2): receipt is ProviderSessionRegistrationV2Receipt {
  if (!validateProviderSessionRegistrationV2ReceiptContract(receipt).ok) return false;
  const value = receipt as ProviderSessionRegistrationV2Receipt;
  return value.organizationId === request.organizationId && value.bindingId === request.bindingId
    && value.name === request.name && value.provider === request.provider && value.delivery === request.delivery
    && value.deviceId === request.deviceId && value.mode === 'cooperative' && value.state === 'active'
    && value.revision >= 1;
}

async function attach(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  const options = attachOptions(flags);
  if (flags.get('dry-run') === true) {
    return { ok: true, stage: 'plan', effects: false, name: options.name, provider: options.provider,
      delivery: options.delivery, mode: 'cooperative', consent: consentText(null) };
  }
  if (flags.get('yes') !== true) throw new Error('session_attach_consent_required');
  const claude = options.provider === 'claude' ? await currentClaudeSession(host) : null;
  const device = await host.device();
  const existing = await readSessionAttachment(host.home, options.name);
  const sameSession = existing && existing.provider === options.provider && existing.organizationId === device.organizationId
    && existing.deviceId === device.deviceId
    && (options.provider === 'codex' ? existing.threadId === options.threadId : existing.claudeSessionId === claude!.sessionId);
  const bindingId = sameSession ? existing.bindingId : randomUUID();
  const request: ProviderSessionRegistrationV2 = { schema: 'dharma.provider-session-registration/v2', action: 'attach',
    organizationId: device.organizationId, deviceId: device.deviceId, bindingId, name: options.name,
    provider: options.provider, delivery: options.delivery, mode: 'cooperative',
    expectedRevision: sameSession ? existing.revision : 0 };
  if (!validateProviderSessionRegistrationV2Contract(request).ok) throw new Error('session_attach_options_invalid');
  const local: LocalSessionAttachment = { schema: 'dharma.local-session-attachment/v1', name: options.name,
    provider: options.provider, delivery: options.delivery, bindingId, organizationId: device.organizationId,
    deviceId: device.deviceId, membershipId: sameSession ? existing.membershipId : null,
    revision: request.expectedRevision, pending: true,
    ...(options.provider === 'codex' ? { threadId: options.threadId } : { claudeSessionId: claude!.sessionId, cwd: claude!.cwd }),
    updatedAt: host.now().toISOString() };
  // Written before the call, so a retry after a lost response reuses this binding id.
  await writeSessionStateFile(attachmentPath(host.home, options.name), local);
  const transport = await host.transport();
  let receipt: Record<string, unknown>;
  try { receipt = await transport.signedPost(SESSION_MESSAGE_ROUTES.attach, request); } catch (error) {
    // The binding id and expected revision make the request idempotent: one identical retry.
    if (!isUncertainSessionTransportFailure(error)) throw error;
    receipt = await transport.signedPost(SESSION_MESSAGE_ROUTES.attach, request);
  }
  if (!receiptMatches(receipt, request)) throw new Error('session_attach_receipt_invalid');
  await writeSessionStateFile(attachmentPath(host.home, options.name), { ...local, membershipId: receipt.membershipId,
    revision: receipt.revision, pending: false, updatedAt: receipt.updatedAt });
  return { ok: true, name: receipt.name, state: receipt.state, provider: receipt.provider, delivery: receipt.delivery,
    mode: receipt.mode, revision: receipt.revision, replay: receipt.replay, consent: consentText(device.organizationId) };
}

const DIRECTORY_KEYS = 'lastSeenAt,name,ownerDisplayName,provider,state';

function seen(lastSeenAt: string | null, now: Date) {
  if (lastSeenAt === null) return 'not seen yet';
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(lastSeenAt)) / 60_000));
  return `seen ${minutes} min ago`;
}

async function list(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['json'], ['json'], 'session_list_options_invalid');
  const response = await (await host.transport()).signedGet(SESSION_MESSAGE_ROUTES.directory);
  const rows = response.sessions;
  const invalid = () => new Error('session_directory_response_invalid');
  if (!Array.isArray(rows) || Object.keys(response).join(',') !== 'sessions') throw invalid();
  const local = new Set((await listSessionAttachments(host.home)).map(item => item.name));
  return { ok: true, sessions: rows.map((row: unknown) => {
    // Only the documented directory fields: never a device id, hostname or provider session id.
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== DIRECTORY_KEYS) throw invalid();
    const value = row as Record<string, unknown>;
    if (typeof value.name !== 'string' || !SESSION_NAME_PATTERN.test(value.name)
      || !['codex', 'claude'].includes(String(value.provider)) || typeof value.ownerDisplayName !== 'string'
      || !['active', 'detached', 'suspended'].includes(String(value.state))
      || !(value.lastSeenAt === null || typeof value.lastSeenAt === 'string' && Number.isFinite(Date.parse(value.lastSeenAt)))) {
      throw invalid();
    }
    return { name: value.name, provider: value.provider, owner: value.ownerDisplayName,
      seen: seen(value.lastSeenAt as string | null, host.now()), lastSeenAt: value.lastSeenAt, state: value.state,
      attachedHere: local.has(value.name) };
  }) };
}

/** `dharma sessions attach|list`: delivery-only bindings, so no Linux sandbox or workspace gate applies. */
export async function sessionNamesCommand(action: string, flags: Map<string, string | boolean>,
  host: SessionMessagingHost): Promise<Record<string, unknown>> {
  if (action === 'attach') return attach(flags, host);
  if (action === 'list') return list(flags, host);
  throw new Error('session_names_command_invalid');
}
