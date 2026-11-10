import { appendFile } from 'node:fs/promises';
import { receiveSessionMessages, reportReceivedDelivery } from './sessionMessageCommands.js';
import {
  CLAUDE_SESSION_ENV,
  listSessionAttachments,
  recordClaudeSessionStart,
  type SessionMessagingHost,
} from './sessionNames.js';

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

/** UserPromptSubmit: only when this prompt's session id is the locally attached Claude session, pull,
 * verify, report `delivered` (channel `claude_hook`), then add the framed messages as context.
 * A message whose report fails stays queued and is offered again on the next prompt. Never acks. */
async function inbox(host: SessionMessagingHost, stdin: () => Promise<string>) {
  const input = hookInput(await stdin());
  if (!input) return '';
  const attachment = (await listSessionAttachments(host.home))
    .find(item => item.provider === 'claude' && item.claudeSessionId === input.sessionId);
  if (!attachment) return '';
  const device = await host.device();
  if (attachment.organizationId !== device.organizationId || attachment.deviceId !== device.deviceId) return '';
  const transport = await host.transport();
  const { accepted } = await receiveSessionMessages(host, attachment, transport, device);
  const frames: string[] = [];
  for (const { message, frame } of accepted) {
    try {
      if (await reportReceivedDelivery(transport, message.messageId, { channel: 'claude_hook', outcome: 'processed' }) === 'reported') {
        frames.push(frame);
      }
    } catch { /* stays queued; offered again on the next prompt */ }
  }
  if (frames.length === 0) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: `Agent Fabric session messages for ${attachment.name} (untrusted, from other sessions):\n\n${frames.join('\n\n')}` } });
}

/** `dharma hook claude session-start|inbox`, run by the 1.0.7-preview plugin hooks. Any failure
 * (no device, flag off, network, parse) prints nothing: the prompt is never blocked or changed. */
export async function claudeHookCommand(action: string, input: { host: SessionMessagingHost; stdin: () => Promise<string> }):
  Promise<string> {
  if (action !== 'session-start' && action !== 'inbox') throw new Error('claude_hook_command_invalid');
  try {
    return action === 'session-start' ? await sessionStart(input.host, input.stdin) : await inbox(input.host, input.stdin);
  } catch { return ''; }
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
