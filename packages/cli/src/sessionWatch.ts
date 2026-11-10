import { spawn } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  reconcileSessionLocalDelivery,
  SESSION_NAME_PATTERN,
  type SessionMessageDeliveryOutcome,
} from '@dharma-ai-labs/agent-fabric-contracts';
import {
  newSessionDeliveryReceipt,
  parseCodexQueueStdout,
  readSessionDeliveryReceipt,
  writeSessionDeliveryReceipt,
  type SessionDeliveryReceipt,
} from './sessionDeliveryReceipt.js';
import { flushSessionOutbox, receiveSessionMessages, reportReceivedDelivery } from './sessionMessageCommands.js';
import { sessionMessageFrameKey } from './sessionMessageFrame.js';
import {
  assertSessionFlags,
  listSessionAttachments,
  readSessionAttachment,
  sessionStatePath,
  type LocalSessionAttachment,
  type SessionMessageTransport,
  type SessionMessagingHost,
} from './sessionNames.js';

/** S1 6.1, 6.4 and 4.5. */
export const CODEX_QUEUE_TIMEOUT_MS = 60_000;
export const EMPTY_READ_GAP_MS = 15_000;
export const NOT_LOADED_IDLE_MS = 60_000;
export const MAX_QUEUE_ATTEMPTS = 2;

export interface CodexQueueResult { exitCode: number | null; stdout: string }
export interface CodexRolloutView {
  /** The turn whose user record carries `key`, and its outcome once the turn ended (null while open). */
  find(key: string): { turnId: string; outcome: SessionMessageDeliveryOutcome | null } | null;
  /** When the thread last became idle; null while a turn is open (busy). */
  idleSince: Date | null;
}
/** The only Codex operations the watcher uses: `codex queue --thread`, a read-only queue-row lookup
 * and the attached thread's rollout. There is deliberately no `exec resume` (S1 3.2). */
export interface CodexDeliveryPort {
  queue(threadId: string, message: string): Promise<CodexQueueResult>;
  pendingRow(threadId: string, key: string): Promise<boolean | 'unknown'>;
  rollout(threadId: string): Promise<CodexRolloutView>;
}

const CONTEXT_PREFIXES = ['<environment_context>', '# AGENTS.md instructions', '<user_instructions>', '<INSTRUCTIONS>'];
/** A delivery is matched only on the frame's own first line. `frameSessionMessage()` neutralises this
 * marker inside bodies, so one message's body can never claim another message's delivery. */
const FRAME_HEADER = /^\[Agent Fabric session message id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) from session /i;
export function sessionMessageFrameHeaderPrefix(messageId: string): string {
  return `[Agent Fabric session message ${sessionMessageFrameKey(messageId)} from session `;
}

/** Incremental reader of one thread's rollout JSONL (codex-cli 0.165.0 shape, S1 section 1). */
export class CodexRolloutTracker {
  #partial = '';
  #lines = 0;
  #openTurn: string | null = null;
  #idleSince: Date | null = null;
  readonly #turns = new Map<string, { ended: 'complete' | 'aborted' | null; realUsers: number }>();
  readonly #keys = new Map<string, string>();
  constructor(readonly threadId: string) {}

  push(text: string) {
    const lines = (this.#partial + text).split('\n');
    this.#partial = lines.pop() ?? '';
    for (const line of lines) this.#line(line);
  }

  #line(raw: string) {
    const line = raw.trim();
    if (!line) return;
    let record: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    try { record = JSON.parse(line) as typeof record; } catch {
      if (this.#lines === 0) throw new Error('codex_rollout_thread_mismatch');
      return;
    }
    const first = this.#lines === 0;
    this.#lines += 1;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const at = typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? new Date(record.timestamp) : null;
    if (first) {
      // Line 0 must be this exact thread's session_meta, so a fork or another thread is never read.
      if (record.type !== 'session_meta' || payload.id !== this.threadId) throw new Error('codex_rollout_thread_mismatch');
      this.#idleSince = at;
      return;
    }
    const kind = payload.type;
    const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
    if (kind === 'task_started' && turnId) {
      // A turn with no task_complete or turn_aborted before the next one starts (Codex was killed mid-turn)
      // is over: close it as aborted, so its message is reported instead of waiting forever.
      const open = this.#openTurn && this.#turns.get(this.#openTurn);
      if (open && open.ended === null && this.#openTurn !== turnId) open.ended = 'aborted';
      this.#openTurn = turnId;
      this.#turns.set(turnId, { ended: null, realUsers: 0 });
      this.#idleSince = null;
    } else if ((kind === 'task_complete' || kind === 'turn_aborted') && (turnId ?? this.#openTurn)) {
      const id = (turnId ?? this.#openTurn)!;
      const turn = this.#turns.get(id) ?? { ended: null, realUsers: 0 };
      turn.ended = kind === 'task_complete' ? 'complete' : 'aborted';
      this.#turns.set(id, turn);
      if (this.#openTurn === id) { this.#openTurn = null; this.#idleSince = at; }
    } else if (record.type === 'response_item' && kind === 'message' && payload.role === 'user') {
      const metadata = payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
      const id = typeof metadata?.turn_id === 'string' ? metadata.turn_id : this.#openTurn;
      if (!id) return;
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .map(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text : '').join('\n');
      const turn = this.#turns.get(id) ?? { ended: null, realUsers: 0 };
      if (!CONTEXT_PREFIXES.some(prefix => text.trimStart().startsWith(prefix))) turn.realUsers += 1;
      this.#turns.set(id, turn);
      const match = FRAME_HEADER.exec(text.trimStart());
      if (match) {
        const key = sessionMessageFrameKey(match[1]!.toLowerCase());
        if (!this.#keys.has(key)) this.#keys.set(key, id);
      }
    }
  }

  view(): CodexRolloutView {
    if (this.#lines === 0) throw new Error('codex_rollout_thread_mismatch');
    const turns = new Map(this.#turns);
    const keys = new Map(this.#keys);
    return {
      idleSince: this.#idleSince,
      find(key) {
        const turnId = keys.get(key.toLowerCase());
        if (!turnId) return null;
        const turn = turns.get(turnId)!;
        const outcome = turn.ended === null ? null : turn.ended === 'aborted' ? 'aborted' : turn.realUsers > 1 ? 'merged' : 'processed';
        return { turnId, outcome };
      },
    };
  }
}

export function parseCodexRollout(text: string, threadId: string): CodexRolloutView {
  const tracker = new CodexRolloutTracker(threadId);
  tracker.push(text.endsWith('\n') ? text : `${text}\n`);
  return tracker.view();
}

async function findRollout(sessions: string, threadId: string): Promise<string> {
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const walk = async (directory: string, depth: number) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3) await walk(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) found.push(join(directory, entry.name));
    }
  };
  await walk(sessions, 0);
  if (found.length !== 1) throw new Error(found.length ? 'codex_rollout_ambiguous' : 'codex_rollout_unavailable');
  return found[0]!;
}

/** Default Codex launch: on Windows the npm shim's own `codex.js` under Node, with no shell (multi-line
 * frames survive); elsewhere `codex` from PATH. */
export function defaultCodexCommand(env: Record<string, string | undefined>): { file: string; args: string[] } {
  if (env.DHARMA_CODEX_COMMAND) return codexCommand(env.DHARMA_CODEX_COMMAND);
  if (process.platform === 'win32' && env.APPDATA) {
    return { file: process.execPath, args: [join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] };
  }
  return { file: 'codex', args: [] };
}
function codexCommand(path: string) {
  return /\.(c|m)?js$/i.test(path) ? { file: process.execPath, args: [resolve(path)] } : { file: path, args: [] };
}

/** The real port: `codex queue --thread` with a 60 s kill, a read-only `queued_items` lookup and an
 * incremental rollout reader. Every read fails closed. */
export function createCodexDeliveryPort(input: { codexHome: string; codexCommand: { file: string; args: string[] };
  timeoutMs?: number }): CodexDeliveryPort {
  const trackers = new Map<string, { path: string; offset: number; tracker: CodexRolloutTracker }>();
  return {
    queue: (threadId, message) => new Promise<CodexQueueResult>((done, fail) => {
      const child = spawn(input.codexCommand.file, [...input.codexCommand.args, 'queue', '--thread', threadId, '--message', message],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (stdout.length < 65_536) stdout += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS);
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        done({ exitCode: code ?? (signal ? 137 : null), stdout });
      });
    }),
    pendingRow: async (threadId, key) => {
      const path = join(input.codexHome, 'queue_1.sqlite');
      try { await stat(path); } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown';
      }
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          return db.prepare('SELECT 1 AS hit FROM queued_items WHERE thread_id = ? AND instr(payload_json, ?) > 0 LIMIT 1')
            .get(threadId, key) !== undefined;
        } finally { db.close(); }
      } catch { return 'unknown'; }
    },
    rollout: async threadId => {
      let state = trackers.get(threadId);
      if (!state) {
        state = { path: await findRollout(join(input.codexHome, 'sessions'), threadId), offset: 0, tracker: new CodexRolloutTracker(threadId) };
        trackers.set(threadId, state);
      }
      const handle = await open(state.path, 'r');
      try {
        const { size } = await handle.stat();
        if (size < state.offset) throw new Error('codex_rollout_truncated');
        if (size > state.offset) {
          const buffer = Buffer.alloc(size - state.offset);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
          state.offset += bytesRead;
          state.tracker.push(buffer.subarray(0, bytesRead).toString('utf8'));
        }
      } finally { await handle.close(); }
      return state.tracker.view();
    },
  };
}

/** One watcher pass at a time per name on this device (`session-messages/watch/<name>.lock`, created
 * exclusively). Two watchers would both find no trace and both run `codex queue`. A lock whose process no
 * longer exists is taken over. */
export async function withSessionWatchLock<T>(home: string, name: string, run: () => Promise<T>): Promise<T> {
  if (!SESSION_NAME_PATTERN.test(name)) throw new Error('session_name_invalid');
  const path = sessionStatePath(home, 'watch', `${name}.lock`);
  await mkdir(sessionStatePath(home, 'watch'), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) {
        throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? new Error('session_watch_already_running') : error;
      }
      let holder: { pid?: unknown } | null = null;
      try { holder = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }; } catch { holder = null; }
      if (holder === null || processAlive(holder.pid)) throw new Error('session_watch_already_running');
      await rm(path, { force: true });
    }
  }
  try { return await run(); } finally {
    try {
      const holder = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
      if (holder.token === token) await rm(path, { force: true });
    } catch { /* already gone */ }
  }
}

function processAlive(pid: unknown) {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type SessionWatchAction = 'queued' | 'submitted_unconfirmed' | 'waiting' | 'reconciling' | 'queued_not_loaded'
  | 'observed_turn_open' | 'reported' | 'already_delivered' | 'uncertain' | 'error';
export interface SessionWatchEntry { messageId: string; action: SessionWatchAction; outcome?: SessionMessageDeliveryOutcome; code?: string }

/** One watcher pass for one attached Codex name. Per message: reconcile (receipt, pending row, rollout)
 * before any queue call; `codex queue --thread` only when there is no trace; `delivered` with channel
 * `codex_queue` only once the framed id is in the attached thread's rollout and its turn ended. Never acks. */
export async function watchCodexSessionOnce(input: {
  host: SessionMessagingHost; attachment: LocalSessionAttachment; port: CodexDeliveryPort;
  transport: SessionMessageTransport; device: { organizationId: string; deviceId: string; privateKey: KeyObject };
}) {
  if (input.attachment.provider !== 'codex' || !input.attachment.threadId) throw new Error('session_watch_attachment_invalid');
  return withSessionWatchLock(input.host.home, input.attachment.name, () => watchPass(input));
}

async function watchPass(input: Parameters<typeof watchCodexSessionOnce>[0]) {
  const { host, attachment, port, transport } = input;
  const threadId = attachment.threadId!;
  const { accepted, refused } = await receiveSessionMessages(host, attachment, transport, input.device);
  const entries: SessionWatchEntry[] = [];
  let rollout: CodexRolloutView | undefined;
  for (const { message, frame } of accepted) {
    const messageId = message.messageId;
    const key = sessionMessageFrameKey(messageId);
    const now = host.now();
    const save = (receipt: SessionDeliveryReceipt) => writeSessionDeliveryReceipt(host.home, { ...receipt, updatedAt: host.now().toISOString() });
    try {
      let receipt = await readSessionDeliveryReceipt(host.home, messageId);
      if (receipt?.state === 'uncertain') { entries.push({ messageId, action: 'uncertain' }); continue; }
      rollout ??= await port.rollout(threadId);
      const found = rollout.find(key);
      const pending = found ? false : await port.pendingRow(threadId, sessionMessageFrameHeaderPrefix(messageId));
      const decision = reconcileSessionLocalDelivery({ queueId: receipt?.queueId ?? null, pendingRow: pending === true, inRollout: found !== null });
      if (decision === 'report_delivered') {
        const base = receipt ?? newSessionDeliveryReceipt({ messageId, recipientName: attachment.name, threadId, now });
        if (found!.outcome === null) {
          await save({ ...base, state: 'observed', turnId: found!.turnId });
          entries.push({ messageId, action: 'observed_turn_open' });
          continue;
        }
        // Posts a reply or ack the recipient parked during this turn right after `delivered` (never an ack of its own).
        const report = await reportReceivedDelivery(transport, messageId, { channel: 'codex_queue', outcome: found!.outcome }, host.home);
        await save({ ...base, state: 'reported', turnId: found!.turnId, outcome: found!.outcome, report });
        entries.push({ messageId, action: report === 'reported' ? 'reported' : 'already_delivered', outcome: found!.outcome });
        continue;
      }
      if (decision === 'wait' || pending === 'unknown') {
        const since = Math.max(Date.parse(receipt?.queuedAt ?? receipt?.submittedAt ?? now.toISOString()),
          rollout.idleSince?.getTime() ?? Number.POSITIVE_INFINITY);
        if (receipt && pending === true && rollout.idleSince && now.getTime() - since >= NOT_LOADED_IDLE_MS) {
          if (!receipt.queuedNotLoadedAt) await save({ ...receipt, queuedNotLoadedAt: now.toISOString() });
          entries.push({ messageId, action: 'queued_not_loaded' });
        } else entries.push({ messageId, action: 'waiting' });
        continue;
      }
      // decision === 'queue': no queue id, no pending row, not in the rollout.
      if (receipt && receipt.attempts > 0) {
        const reads = [...receipt.emptyReads, now.toISOString()];
        const span = Date.parse(reads.at(-1)!) - Date.parse(reads[0]!);
        if (reads.length < 2 || span < EMPTY_READ_GAP_MS) {
          await save({ ...receipt, emptyReads: reads });
          entries.push({ messageId, action: 'reconciling' });
          continue;
        }
        if (receipt.attempts >= MAX_QUEUE_ATTEMPTS) {
          await save({ ...receipt, state: 'uncertain', emptyReads: reads });
          entries.push({ messageId, action: 'uncertain' });
          continue;
        }
      }
      receipt = { ...(receipt ?? newSessionDeliveryReceipt({ messageId, recipientName: attachment.name, threadId, now })),
        state: 'submitting', attempts: (receipt?.attempts ?? 0) + 1, submittedAt: now.toISOString(), emptyReads: [] };
      // Durable before the call: a crash after `codex queue` commits its row reconciles instead of queueing again.
      await save(receipt);
      const result = await port.queue(threadId, frame);
      const queueId = parseCodexQueueStdout(result.stdout, threadId);
      if (queueId) {
        await save({ ...receipt, state: 'queued', queueId, queuedAt: host.now().toISOString() });
        entries.push({ messageId, action: 'queued' });
      } else entries.push({ messageId, action: 'submitted_unconfirmed' });
    } catch (error) {
      entries.push({ messageId, action: 'error', code: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    }
  }
  // Parked requests whose post was uncertain last time; a message still queued stays parked.
  let outbox: Awaited<ReturnType<typeof flushSessionOutbox>> = [];
  try { outbox = (await flushSessionOutbox(host.home, transport)).filter(item => item.action !== 'parked'); } catch { outbox = []; }
  return { ok: true, name: attachment.name, entries, refused, outbox };
}

const WAKE_CONSENT = 'Delivering with codex queue into an idle thread starts a turn with nobody at the keyboard (auto-wake). '
  + 'Messages are framed as untrusted text; the session still acts only with its own permissions.';

/** `dharma sessions watch --provider codex [--name <n>] --allow-wake [--once] [--interval-ms <ms>]`. */
export async function sessionWatchCommand(flags: Map<string, string | boolean>, host: SessionMessagingHost,
  makePort: (input: { codexHome: string; codexCommand: { file: string; args: string[] } }) => CodexDeliveryPort = createCodexDeliveryPort,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  const invalid = 'session_watch_options_invalid';
  assertSessionFlags(flags, ['provider', 'name', 'allow-wake', 'once', 'interval-ms', 'codex-command', 'dry-run', 'json'],
    ['allow-wake', 'once', 'dry-run', 'json'], invalid);
  if (flags.get('provider') !== 'codex') throw new Error(invalid);
  const name = flags.get('name') as string | undefined;
  if (name !== undefined && !SESSION_NAME_PATTERN.test(name)) throw new Error(invalid);
  const intervalMs = flags.has('interval-ms') ? Number(flags.get('interval-ms')) : 10_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) throw new Error(invalid);
  const dryRun = flags.get('dry-run') === true;
  if (!dryRun && flags.get('allow-wake') !== true) throw new Error('session_watch_wake_consent_required');
  const codexNames = name !== undefined ? [] : (await listSessionAttachments(host.home)).filter(item => item.provider === 'codex');
  if (codexNames.length > 1) throw new Error('session_watch_attachment_ambiguous');
  const attachment = name !== undefined ? await readSessionAttachment(host.home, name) : codexNames[0] ?? null;
  if (!attachment || attachment.pending || attachment.provider !== 'codex') throw new Error('session_watch_attachment_invalid');
  if (dryRun) {
    return { ok: true, stage: 'plan', effects: false, action: 'watch', name: attachment.name, threadId: attachment.threadId,
      delivery: 'codex_queue', allowWake: flags.get('allow-wake') === true, once: flags.get('once') === true, intervalMs,
      consent: WAKE_CONSENT };
  }
  const device = await host.device();
  if (attachment.organizationId !== device.organizationId || attachment.deviceId !== device.deviceId) {
    throw new Error('session_attachment_device_changed');
  }
  const codexHome = host.env.CODEX_HOME ? resolve(host.env.CODEX_HOME) : join(homedir(), '.codex');
  const command = flags.has('codex-command') ? codexCommand(String(flags.get('codex-command'))) : defaultCodexCommand(host.env);
  const port = makePort({ codexHome, codexCommand: command });
  const transport = await host.transport();
  const tick = () => watchCodexSessionOnce({ host, attachment, port, transport, device });
  if (flags.get('once') === true) return { ...await tick(), consent: WAKE_CONSENT };
  let last: Awaited<ReturnType<typeof tick>> | undefined;
  while (!signal?.aborted) {
    try {
      last = await tick();
      process.stderr.write(`${JSON.stringify({ stage: 'session_watch_tick', at: host.now().toISOString(),
        entries: last.entries, refused: last.refused.length })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ stage: 'session_watch_failure', code: error instanceof Error ? error.message.slice(0, 120) : 'unknown' })}\n`);
    }
    await new Promise<void>(done => { const timer = setTimeout(done, intervalMs); signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
  }
  return { ok: true, name: attachment.name, stopped: true, consent: WAKE_CONSENT, last: last ?? null };
}
