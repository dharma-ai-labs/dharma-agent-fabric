import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { namedCodexNodeOutputArguments, namedCodexNodeOutputBody } from './namedCodexNodeOutput.js';

function fixture(options: { socket?: boolean; typed?: boolean; partial?: boolean; zero?: boolean; failure?: boolean } = {}) {
  const original = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  if (options.typed) Object.assign(original, { _type: 'pipe' });
  const target = { stdout: original, stderr: original };
  const writes: { fd: number; bytes: Buffer }[] = [];
  const inspected: number[] = [];
  const install = compileFunction(namedCodexNodeOutputBody, ['writeSync', 'fstatSync', 'Writable', 'process']);
  install((fd: number, data: Buffer, offset: number, length: number) => {
    assert.ok(fd === 1 || fd === 2);
    if (options.failure) throw Object.assign(new Error('descriptor denied'), { code: 'EACCES' });
    if (options.zero) return 0;
    const count = options.partial ? Math.min(2, length) : length;
    writes.push({ fd, bytes: Buffer.from(data.subarray(offset, offset + count)) });
    return count;
  }, (fd: number) => {
    inspected.push(fd);
    return { isSocket: () => options.socket !== false };
  }, Writable, target);
  return { original, target, writes, inspected };
}

test('only Linux receives a fixed public Node output module through Codex configuration', () => {
  const args = namedCodexNodeOutputArguments('linux');
  assert.equal(args.length, 2);
  assert.equal(args[0], '-c');
  assert.match(args[1]!, /^shell_environment_policy\.set=\{NODE_OPTIONS="--import=data:text\/javascript;base64,[A-Za-z0-9+/=]+"\}$/);
  for (const platform of ['win32', 'darwin'] as const) assert.deepEqual(namedCodexNodeOutputArguments(platform), []);
});

test('dummy socket streams forward binary bytes only to their existing output descriptors', async () => {
  const value = fixture();
  assert.notEqual(value.target.stdout, value.original);
  const bytes = Buffer.from([255, 15, 0, 128, 1]);
  await new Promise<void>((resolve, reject) => value.target.stdout.write(bytes, error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => value.target.stderr.write('public diagnostic', error => error ? reject(error) : resolve()));
  assert.deepEqual(value.inspected, [1, 2]);
  assert.deepEqual(value.writes[0], { fd: 1, bytes });
  assert.deepEqual(value.writes[1], { fd: 2, bytes: Buffer.from('public diagnostic') });
  assert.equal((value.target.stdout as Writable & { fd?: number }).fd, 1);
});

test('ordinary pipe streams and non-socket outputs are left unchanged', () => {
  for (const options of [{ typed: true }, { socket: false }]) {
    const value = fixture(options);
    assert.equal(value.target.stdout, value.original);
    assert.equal(value.target.stderr, value.original);
    assert.deepEqual(value.writes, []);
  }
});

test('partial descriptor writes preserve every byte exactly once', async () => {
  const value = fixture({ partial: true });
  await new Promise<void>((resolve, reject) => value.target.stdout.write('abcdef', error => error ? reject(error) : resolve()));
  assert.equal(value.writes.length, 3);
  assert.equal(Buffer.concat(value.writes.map(write => write.bytes)).toString(), 'abcdef');
});

test('zero progress and denied output fail rather than reporting a successful write', async () => {
  for (const options of [{ zero: true }, { failure: true }]) {
    const value = fixture(options);
    value.target.stdout.on('error', () => {});
    const error = await new Promise<Error | null | undefined>(resolve => value.target.stdout.write('x', resolve));
    assert.ok(error instanceof Error);
    assert.deepEqual(value.writes, []);
  }
});

test('the public module changes no environment, permission, file or network authority', () => {
  const args = namedCodexNodeOutputArguments('linux');
  const match = args[1]?.match(/base64,([A-Za-z0-9+/=]+)/);
  assert.ok(match);
  const module = Buffer.from(match[1]!, 'base64').toString();
  assert.ok(module.includes(namedCodexNodeOutputBody));
  assert.doesNotMatch(module, /process\.env|readFile|openSync|fetch\(|node:net|child_process|permissions\./);
  assert.match(module, /writeSync/);
  assert.match(module, /fstatSync/);
});

test('the production named launcher installs fixed output options without replacing its policy profiles', () => {
  const entry = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(entry, /argv: \[\.\.\.namedCodexNodeOutputArguments\(\), '-c', 'allow_login_shell=false'/);
  for (const profile of ['dharma_bridge', 'dharma_work']) {
    assert.ok(entry.includes(`permissions.${profile}.network={enabled=false}`));
    assert.ok(entry.includes(`permissions.${profile}.filesystem=`));
  }
});
