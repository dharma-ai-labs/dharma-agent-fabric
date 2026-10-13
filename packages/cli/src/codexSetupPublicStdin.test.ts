import assert from 'node:assert/strict';
import {PassThrough, Readable} from 'node:stream';
import test from 'node:test';
import {readCodexSetupPublicStdin} from './codexSetupPublicStdin.js';

const prompt = '# Public setup\r\nOriginal text is preserved.\n';
test('public stdin preserves valid original bytes across chunks without echo or file transport', async () => {
  const stream = Readable.from([Buffer.from(prompt.slice(0, 8)), Buffer.from(prompt.slice(8))]);
  assert.equal(await readCodexSetupPublicStdin(stream, new AbortController().signal), prompt);
});
for (const reason of ['tty', 'cancelled'] as const) {
  test(`public stdin refuses ${reason} before reading`, async () => {
    let reads = 0;
    const stream = new Readable({read() {reads++; this.push(null);}}) as Readable & {isTTY?: boolean};
    const control = new AbortController();
    if (reason === 'tty') stream.isTTY = true; else control.abort();
    await assert.rejects(readCodexSetupPublicStdin(stream, control.signal), /^Error: codex_setup_public_input_unavailable$/);
    assert.equal(reads, 0);
  });
}
for (const [reason, bytes] of [
  ['oversized', Buffer.alloc(32769, 97)], ['invalid-utf8', Buffer.from([0xc3, 0x28])],
  ['empty', Buffer.alloc(0)], ['credential', Buffer.from(['dhab', 'synthetic', 'never-real'].join('_'))],
] as const) {
  test(`public stdin rejects ${reason} with a constant non-disclosing result`, async () => {
    await assert.rejects(readCodexSetupPublicStdin(Readable.from([bytes]), new AbortController().signal),
      /^Error: codex_setup_public_input_unavailable$/);
  });
}
test('cancellation destroys only the owned waiting public input stream', async () => {
  const stream = new PassThrough(), other = new PassThrough(), control = new AbortController();
  const reading = readCodexSetupPublicStdin(stream, control.signal);
  control.abort();
  await assert.rejects(reading, /^Error: codex_setup_public_input_unavailable$/);
  assert.equal(stream.destroyed, true); assert.equal(other.destroyed, false);
  other.destroy();
});
