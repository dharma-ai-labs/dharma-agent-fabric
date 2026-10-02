import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { bootstrapGrantMode, readPrivateBootstrapGrant } from './privateGrantInput.js';

class Terminal extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readableFlowing: boolean | null = false;
  fd = 0;
  modes: boolean[] = [];
  setRawMode(raw: boolean) { this.isRaw = raw; this.modes.push(raw); return this; }
  resume() { this.readableFlowing = true; return this; }
  pause() { this.readableFlowing = false; return this; }
}
function fixture() {
  const input = new Terminal();
  const signals = new EventEmitter();
  const writes: string[] = [];
  const output = { isTTY: true, fd: 2, write(value: string) { writes.push(value); return true; } };
  return { input, output, signals, writes, isTerminal: () => true };
}
const fakeGrant = 'synthetic-not-a-real-grant';
function restored(io: ReturnType<typeof fixture>) {
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.readableFlowing, false);
  assert.equal(io.input.listenerCount('data'), 0);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'exit']) assert.equal(io.signals.listenerCount(signal), 0);
  assert.equal(io.writes.join('').includes(fakeGrant), false);
}

test('private grant succeeds with raw input, no echo and terminal restoration', async () => {
  const io = fixture();
  const pending = readPrivateBootstrapGrant(io);
  assert.equal(io.input.isRaw, true);
  io.input.emit('data', Buffer.from(fakeGrant + '\r'));
  assert.equal(await pending, fakeGrant);
  assert.deepEqual(io.input.modes, [true, false]);
  restored(io);
});

test('prompt rejects pipe/redirected output and already-owned terminal before changing it', async () => {
  for (const change of [(io: ReturnType<typeof fixture>) => { io.input.isTTY = false; },
    (io: ReturnType<typeof fixture>) => { io.output.isTTY = false; },
    (io: ReturnType<typeof fixture>) => { io.input.isRaw = true; },
    (io: ReturnType<typeof fixture>) => { io.input.on('data', () => {}); }]) {
    const io = fixture(); change(io);
    await assert.rejects(readPrivateBootstrapGrant(io), /private_grant_terminal_required/);
    assert.deepEqual(io.input.modes, []);
  }
  const io = fixture(); io.isTerminal = () => false;
  await assert.rejects(readPrivateBootstrapGrant(io), /private_grant_terminal_required/);
});

test('cancel, EOF, signals, stream failure and oversize restore without exposing input', async () => {
  for (const event of ['ctrl-c', 'ctrl-d', 'escape', 'end', 'close', 'error', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'oversize']) {
    const io = fixture(); const pending = readPrivateBootstrapGrant(io);
    io.input.emit('data', Buffer.from(fakeGrant));
    if (event === 'ctrl-c') io.input.emit('data', Buffer.from([3]));
    else if (event === 'ctrl-d') io.input.emit('data', Buffer.from([4]));
    else if (event === 'escape') io.input.emit('data', Buffer.from([27]));
    else if (event === 'oversize') io.input.emit('data', Buffer.alloc(16_385, 65));
    else if (['end', 'close', 'error'].includes(event)) io.input.emit(event, new Error(fakeGrant));
    else io.signals.emit(event);
    await assert.rejects(pending, /private_grant_(cancelled|input_failed|too_large)/);
    restored(io);
  }
});

test('private entry rejects empty, multiline, whitespace, non-ASCII and control content', async () => {
  for (const text of ['\r', fakeGrant + '\nsecond-command', 'bad token\r', 'é\r', '\x00\r']) {
    const io = fixture(); const pending = readPrivateBootstrapGrant(io);
    io.input.emit('data', Buffer.from(text));
    await assert.rejects(pending, /private_grant_invalid/);
    restored(io);
  }
});

test('private entry handles backspace and split paste without echo', async () => {
  const io = fixture(); const pending = readPrivateBootstrapGrant(io);
  io.input.emit('data', Buffer.from('synthetic-not-a-real-grantX\x7f'));
  io.input.emit('data', Buffer.from('\r\n'));
  assert.equal(await pending, fakeGrant);
  restored(io);
});

test('bracketed paste boundaries may be split without accepting a pasted command or newline', async () => {
  const io = fixture(); const pending = readPrivateBootstrapGrant(io);
  for (const piece of ['\x1b', '[20', '0~', fakeGrant, '\x1b[2', '01~', '\r']) {
    io.input.emit('data', Buffer.from(piece));
  }
  assert.equal(await pending, fakeGrant);
  restored(io);
  const bad = fixture(); const rejected = readPrivateBootstrapGrant(bad);
  bad.input.emit('data', Buffer.from('\x1b[200~' + fakeGrant + '\ncommand\x1b[201~'));
  await assert.rejects(rejected, /private_grant_invalid/);
  restored(bad);
});

test('process exit restores terminal without emitting private input', () => {
  const io = fixture(); void readPrivateBootstrapGrant(io);
  io.input.emit('data', Buffer.from(fakeGrant));
  io.signals.emit('exit');
  restored(io);
});

test('raw-mode setup and prompt-write failures are sanitized and restored', async () => {
  for (const where of ['raw', 'write']) {
    const io = fixture();
    if (where === 'raw') io.input.setRawMode = () => { throw new Error(fakeGrant); };
    else io.output.write = () => { throw new Error(fakeGrant); };
    await assert.rejects(readPrivateBootstrapGrant(io), /private_grant_input_failed/);
    assert.equal(io.input.listenerCount('data'), 0);
    assert.equal(io.input.isRaw, false);
  }
});

test('supported grant modes preserve legacy and resume while rejecting conflict/value confusion', () => {
  const flags = (...values: Array<[string, string | boolean]>) => new Map(values);
  assert.equal(bootstrapGrantMode(flags(['grant-prompt', true])), 'prompt');
  assert.equal(bootstrapGrantMode(flags(['grant', fakeGrant])), 'argument');
  assert.equal(bootstrapGrantMode(flags(['resume', true])), 'resume');
  for (const values of [[['grant', fakeGrant], ['grant-prompt', true]],
    [['resume', true], ['grant-prompt', true]], [['resume', true], ['grant', fakeGrant]],
    [['grant-prompt', fakeGrant]], [['grant-prompt', 'false']], [['grant', true]], []] as Array<Array<[string, string | boolean]>>) {
    assert.throws(() => bootstrapGrantMode(flags(...values)), /bootstrap_grant_options_invalid/);
  }
});
