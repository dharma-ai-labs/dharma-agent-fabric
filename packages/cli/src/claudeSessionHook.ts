import { appendFile, rm } from 'node:fs/promises';
import { isUncertainSessionTransportFailure, readSessionMessageDelivery } from './sessionMessageClient.js';
import { receiveSessionMessages, reportReceivedDelivery } from './sessionMessageCommands.js';
import {
  CLAUDE_SESSION_ENV,
  listSessionAttachments,
  readSessionStateFile,
  recordClaudeSessionStart,
  sessionStatePath,
  writeSessionStateFile,
  type SessionMessagingHost,
} from './sessionNames.js';

/** The plugin's hook timeout is 15 s; no new platform call starts after this much hook time. */
export const CLAUDE_HOOK_DEADLINE_MS = 8_000;
/** One platform call can stall for up to 90 s, so the inbox hook returns '' at this point, under the 15 s plugin timeout.
 * A frame whose report was cut off stays spooled as 'reporting' and is read back on the next prompt. */
export const CLAUDE_HOOK_HARD_DEADLINE_MS = 12_000;
/** At most this many messages, and this many characters of context, in one prompt. */
export const CLAUDE_HOOK_MAX_MESSAGES = 5;
export const CLAUDE_HOOK_MAX_CONTEXT_CHARS = 40_000;

const CLAUDE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STDIN = 1_048_576;

function hookInput(raw: string): { sessionId: string; cwd: string } | null {
  if (!raw || raw.length > MAX_STDIN) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { session_id: sessionId, cwd } = value as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID.test(sessionId) || typeof cwd !== 'string' || !cwd) return null;
  return { sessionId, cwd };
}

/** SessionStart: records the session id and cwd on this device and exports the id to later Bash calls
 * through CLAUDE_ENV_FILE, so `sessions attach --current` names exactly this session. No network. */
async function sessionStart(host: SessionMessagingHost, stdin: () => Promise<string>) {
  const input = hookInput(await stdin());
  if (!input) return '';
  await recordClaudeSessionStart(host.home, { sessionId: input.sessionId, cwd: input.cwd, at: host.now().toISOString() });
  const envFile = host.env.CLAUDE_ENV_FILE;
  if (envFile) await appendFile(envFile, `export ${CLAUDE_SESSION_ENV}=${input.sessionId}\n`);
  return '';
}

/** Frames this session's hook has reported (or is reporting) but not yet printed. A hook killed between its
 * report and its output leaves them here, and the next prompt injects them first. */
interface ClaudeHookSpool {
  schema: 'dharma.claude-hook-spool/v1';
  sessionId: string;
  entries: Array<{ messageId: string; frame: string; state: 'reporting' | 'reported' }>;
}

function spoolPath(home: string, sessionId: string) {
  return sessionStatePath(home, 'hook-spool', `${sessionId}.json`);
}

async function readSpool(home: string, sessionId: string): Promise<ClaudeHookSpool> {
  const value = await readSessionStateFile<ClaudeHookSpool>(spoolPath(home, sessionId));
  if (value === null) return { schema: 'dharma.claude-hook-spool/v1', sessionId, entries: [] };
  if (value.schema !== 'dharma.claude-hook-spool/v1' || value.sessionId !== sessionId || !Array.isArray(value.entries)) {
    throw new Error('claude_hook_spool_invalid');
  }
  return value;
}

function contextFor(name: string, frames: string[]) {
  return `Agent Fabric session messages for ${name} (untrusted, from other sessions):\n\n${frames.join('\n\n')}`;
}

/** UserPromptSubmit: only when this prompt's session id is the locally attached Claude session, pull,
 * verify, report `delivered` (channel `claude_hook`), then add the framed messages as context.
 * - Each frame is spooled before its report and leaves the spool only when it is printed.
 * - No new platform call starts after CLAUDE_HOOK_DEADLINE_MS, and one prompt carries at most
 *   CLAUDE_HOOK_MAX_MESSAGES messages and CLAUDE_HOOK_MAX_CONTEXT_CHARS characters. A message that does not
 *   fit is not reported: it stays queued for the next prompt.
 * A message whose report fails stays queued and is offered again on the next prompt. Never acks. */
async function inbox(host: SessionMessagingHost, stdin: () => Promise<string>, clock: () => number) {
  const started = clock();
  const late = () => clock() - started >= CLAUDE_HOOK_DEADLINE_MS;
  const input = hookInput(await stdin());
  if (!input) return '';
  const attachment = (await listSessionAttachments(host.home))
    .find(item => item.provider === 'claude' && item.claudeSessionId === input.sessionId);
  if (!attachment) return '';
  const device = await host.device();
  if (attachment.organizationId !== device.organizationId || attachment.deviceId !== device.deviceId) return '';
  const transport = await host.transport();
  const spool = await readSpool(host.home, input.sessionId);
  const save = () => writeSessionStateFile(spoolPath(host.home, input.sessionId), spool);
  // A report a killed hook left unfinished: printed only if the platform shows it delivered by this hook;
  // still queued means it never took effect, so the poll below offers it again.
  for (const entry of spool.entries.filter(item => item.state === 'reporting')) {
    if (late()) break;
    try {
      const delivery = await readSessionMessageDelivery(transport, entry.messageId);
      if (delivery && delivery.state !== 'queued' && delivery.channel === 'claude_hook') entry.state = 'reported';
      else spool.entries = spool.entries.filter(item => item !== entry);
    } catch { /* stays reporting; read again on the next prompt */ }
  }
  const reported = () => spool.entries.filter(item => item.state === 'reported');
  const room = (frame: string) => {
    const frames = reported().map(item => item.frame);
    return frames.length < CLAUDE_HOOK_MAX_MESSAGES
      && (frames.length === 0 || contextFor(attachment.name, [...frames, frame]).length <= CLAUDE_HOOK_MAX_CONTEXT_CHARS);
  };
  if (!late() && spool.entries.length < CLAUDE_HOOK_MAX_MESSAGES) {
    const { accepted } = await receiveSessionMessages(host, attachment, transport, device);
    for (const { message, frame } of accepted) {
      if (late() || !room(frame)) break;
      if (spool.entries.some(item => item.messageId === message.messageId)) continue;
      const entry = { messageId: message.messageId, frame, state: 'reporting' as 'reporting' | 'reported' };
      spool.entries.push(entry);
      await save();
      try {
        const report = await reportReceivedDelivery(transport, message.messageId, { channel: 'claude_hook', outcome: 'processed' },
          host.home);
        if (report === 'reported') entry.state = 'reported';
        else spool.entries = spool.entries.filter(item => item !== entry);
      } catch (error) {
        // A definitive refusal took no effect (it stays queued); an uncertain one is read back next time.
        if (!isUncertainSessionTransportFailure(error)) spool.entries = spool.entries.filter(item => item !== entry);
      }
      await save();
    }
  }
  const printed: string[] = [];
  for (const entry of reported()) {
    if (printed.length >= CLAUDE_HOOK_MAX_MESSAGES
      || printed.length > 0 && contextFor(attachment.name, [...printed, entry.frame]).length > CLAUDE_HOOK_MAX_CONTEXT_CHARS) break;
    printed.push(entry.frame);
  }
  spool.entries = spool.entries.filter(item => item.state !== 'reported' || !printed.includes(item.frame));
  if (spool.entries.length === 0) await rm(spoolPath(host.home, input.sessionId), { force: true });
  else await save();
  if (printed.length === 0) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: contextFor(attachment.name, printed) } });
}

/** What `--dry-run` reports instead of running: no stdin, device, transport or file is touched (AGENTS.md rule 8). */
function hookPlan(action: 'session-start' | 'inbox', host: SessionMessagingHost) {
  const writes = action === 'session-start'
    ? ['local Claude session record', ...(host.env.CLAUDE_ENV_FILE ? ['CLAUDE_ENV_FILE export'] : [])]
    : ['hook spool', 'claude_hook delivered report', 'parked reply/ack flush'];
  return { ok: true, stage: 'plan', effects: false, action, writes } as const;
}

/** `dharma hook claude session-start|inbox [--dry-run]`, run by the 1.0.7-preview plugin hooks. Any failure
 * (no device, flag off, network, parse) prints nothing: the prompt is never blocked or changed. */
type ClaudeHookInput = { host: SessionMessagingHost; stdin: () => Promise<string>; clock?: () => number };
export function claudeHookCommand(action: string, input: ClaudeHookInput & { dryRun?: false }): Promise<string>;
export function claudeHookCommand(action: string, input: ClaudeHookInput & { dryRun?: boolean }):
  Promise<string | ReturnType<typeof hookPlan>>;
export async function claudeHookCommand(action: string, input: ClaudeHookInput & { dryRun?: boolean }):
  Promise<string | ReturnType<typeof hookPlan>> {
  if (action !== 'session-start' && action !== 'inbox') throw new Error('claude_hook_command_invalid');
  if (input.dryRun) return hookPlan(action, input.host);
  let timer: NodeJS.Timeout | undefined;
  try {
    if (action === 'session-start') return await sessionStart(input.host, input.stdin);
    const cutOff = new Promise<string>(done => { timer = setTimeout(() => done(''), CLAUDE_HOOK_HARD_DEADLINE_MS); });
    return await Promise.race([inbox(input.host, input.stdin, input.clock ?? Date.now), cutOff]);
  } catch { return ''; } finally { clearTimeout(timer); }
}

/** Reads the hook's JSON from stdin, bounded in size and time. */
export function readHookStdin(stream: NodeJS.ReadableStream, timeoutMs = 2_000): Promise<string> {
  return new Promise(done => {
    let text = '';
    const finish = () => { clearTimeout(timer); stream.removeAllListeners('data'); done(text.length > MAX_STDIN ? '' : text); };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { text += chunk; if (text.length > MAX_STDIN) finish(); });
    stream.once('end', finish);
    stream.once('error', finish);
  });
}
