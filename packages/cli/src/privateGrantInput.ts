import { isatty } from 'node:tty';
import type { EventEmitter } from 'node:events';

type TerminalInput = Pick<EventEmitter, 'on' | 'removeListener' | 'listenerCount'> & {
  isTTY: boolean; isRaw: boolean; fd: number; readableFlowing: boolean | null;
  setRawMode(raw: boolean): unknown; resume(): unknown; pause(): unknown;
};
type TerminalOutput = { isTTY: boolean; fd: number; write(value: string): unknown };
type Signals = Pick<EventEmitter, 'on' | 'removeListener'>;
interface PrivateGrantTerminal {
  input: TerminalInput;
  output: TerminalOutput;
  signals: Signals;
  isTerminal: (fd: number) => boolean;
}

const MAX_GRANT_BYTES = 16_384;
const CANCEL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'] as const;

export function bootstrapGrantMode(flags: Map<string, string | boolean>): 'resume' | 'argument' | 'prompt' | 'reference' {
  if (flags.has('setup-reference')) {
    if (flags.has('grant') || flags.has('grant-prompt') || flags.has('resume') || flags.has('replace-existing-enrollment')
      || typeof flags.get('setup-reference') !== 'string') {
      throw new Error('bootstrap_grant_options_invalid: --setup-reference cannot combine with grant, resume or enrollment replacement.');
    }
    return 'reference';
  }
  if (['setup-recipient-membership-id', 'setup-scope-digest', 'setup-contract-digest'].some(key => flags.has(key))) {
    throw new Error('bootstrap_grant_options_invalid: setup context requires --setup-reference.');
  }
  const grant = flags.get('grant');
  const prompt = flags.get('grant-prompt');
  if ((flags.has('resume') && (flags.has('grant') || flags.has('grant-prompt')))
    || (flags.has('grant') && flags.has('grant-prompt'))
    || (flags.has('grant-prompt') && prompt !== true)) {
    throw new Error('bootstrap_grant_options_invalid: --grant-prompt takes no value and cannot be combined with --grant or --resume.');
  }
  if (flags.has('resume')) return 'resume';
  if (prompt === true) return 'prompt';
  if (typeof grant === 'string' && grant.length > 0) return 'argument';
  throw new Error('bootstrap_grant_options_invalid: use --grant-prompt for private terminal entry, or an existing supported --grant invocation.');
}

/** Read only from the user's own terminal. No pipe, environment, file or echo fallback. */
export async function readPrivateBootstrapGrant(terminal: PrivateGrantTerminal = {
  input: process.stdin as TerminalInput, output: process.stderr as TerminalOutput,
  signals: process, isTerminal: isatty,
}): Promise<string> {
  const { input, output, signals, isTerminal } = terminal;
  if (!input.isTTY || !output.isTTY || !isTerminal(input.fd) || !isTerminal(output.fd)
    || input.isRaw || input.listenerCount('data') !== 0) {
    throw new Error('private_grant_terminal_required: run this command directly in your own interactive terminal; do not pipe, redirect or send the grant through an agent.');
  }
  const wasFlowing = input.readableFlowing;
  const bytes = Buffer.alloc(MAX_GRANT_BYTES);
  let length = 0;
  let finished = false;
  let escape = '';
  let pasting = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<string>((resolve, reject) => {
    const restore = (): boolean => {
      clearTimeout(escapeTimer);
      clearTimeout(inputTimer);
      input.removeListener('data', onData);
      input.removeListener('end', onFailure);
      input.removeListener('close', onFailure);
      input.removeListener('error', onFailure);
      for (const signal of CANCEL_SIGNALS) signals.removeListener(signal, onCancel);
      signals.removeListener('exit', onExit);
      bytes.fill(0);
      length = 0;
      try {
        if (input.isRaw) input.setRawMode(false);
        if (wasFlowing === true) input.resume(); else input.pause();
        return true;
      } catch { return false; }
    };
    const finish = (code?: string, value?: string) => {
      if (finished) return;
      finished = true;
      const restored = restore();
      try { output.write('\n'); } catch { /* Never print input or an underlying error. */ }
      if (code || !restored) reject(new Error(code || 'private_grant_input_failed'));
      else resolve(value!);
    };
    const onCancel = () => finish('private_grant_cancelled');
    const onFailure = () => finish('private_grant_input_failed');
    const onExit = () => { finished = true; restore(); };
    const onData = (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length > MAX_GRANT_BYTES + 14) { finish('private_grant_too_large'); return; }
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]!;
        if (escape || byte === 27) {
          escape += String.fromCharCode(byte);
          const start = '\x1b[200~'; const end = '\x1b[201~';
          if (escape === start && !pasting && length === 0) { pasting = true; escape = ''; clearTimeout(escapeTimer); }
          else if (escape === end && pasting) { pasting = false; escape = ''; clearTimeout(escapeTimer); }
          else if (!start.startsWith(escape) && !end.startsWith(escape)) { onCancel(); return; }
          else { clearTimeout(escapeTimer); escapeTimer = setTimeout(onCancel, 1_000); }
          continue;
        }
        if ([3, 4, 26].includes(byte)) { onCancel(); return; }
        if (byte === 10 || byte === 13) {
          if (pasting || length === 0 || chunk.subarray(index + 1).some((next) => next !== 10 && next !== 13)) {
            finish('private_grant_invalid'); return;
          }
          finish(undefined, bytes.subarray(0, length).toString('ascii')); return;
        }
        if (byte === 8 || byte === 127) { if (length > 0) bytes[--length] = 0; continue; }
        if (byte < 33 || byte > 126) { finish('private_grant_invalid'); return; }
        if (length === MAX_GRANT_BYTES) { finish('private_grant_too_large'); return; }
        bytes[length++] = byte;
      }
    };
    input.on('data', onData);
    input.on('end', onFailure);
    input.on('close', onFailure);
    input.on('error', onFailure);
    for (const signal of CANCEL_SIGNALS) signals.on(signal, onCancel);
    signals.on('exit', onExit);
    try {
      input.setRawMode(true);
      output.write('Paste your short-lived setup grant here, then press Enter (input hidden; Ctrl+C cancels): ');
      inputTimer = setTimeout(() => finish('private_grant_cancelled'), 300_000);
      input.resume();
    } catch { onFailure(); }
  });
}
