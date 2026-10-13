import type {Readable} from 'node:stream';
import {capturePublicCodexSetupPrompt} from './codexSetupUserPrompt.js';

/** Agent-supplied public text only; never a terminal password/grant prompt. */
export async function readCodexSetupPublicStdin(stream: Readable & {isTTY?: boolean}, signal: AbortSignal): Promise<string> {
  const fail = () => new Error('codex_setup_public_input_unavailable');
  if (stream.isTTY || signal.aborted) throw fail();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const cancel = () => stream.destroy(fail());
  deadline.addEventListener('abort', cancel, {once: true});
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of stream) {
      if (deadline.aborted) throw fail();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 32768) throw fail();
      chunks.push(bytes);
    }
    if (deadline.aborted) throw fail();
    const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw fail();
    return capturePublicCodexSetupPrompt(text);
  } catch {throw fail();}
  finally {deadline.removeEventListener('abort', cancel);}
}
