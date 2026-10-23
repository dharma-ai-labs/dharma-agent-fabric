import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'boundedJsonlLines');
assert.ok(declaration && ts.isFunctionDeclaration(declaration));
const javascript = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;

type BoundedLines = (path: string, size: number, maximumBytes: number) => Promise<{
  lines: string[]; tailOffset: number | null;
}>;

function fixture(text: string, options: {chunk?: number; eofAt?: number; errorAt?: number} = {}) {
  const bytes = Buffer.from(text);
  const reads: Array<{position: number; length: number; bytesRead: number}> = [];
  let closes = 0, opens = 0;
  const open = async (path: string, mode: string) => {
    opens++;
    assert.equal(path, 'synthetic-session.jsonl'); assert.equal(mode, 'r');
    return {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        if (reads.length === options.errorAt) throw new Error('synthetic read failure');
        const end = Math.min(bytes.length, options.eofAt ?? bytes.length);
        const bytesRead = Math.max(0, Math.min(length, options.chunk ?? length, end - position));
        bytes.copy(buffer, offset, position, position + bytesRead);
        reads.push({position, length, bytesRead});
        return {bytesRead, buffer};
      },
      async close() {closes++;},
    };
  };
  const read = compileFunction(`${javascript}; return boundedJsonlLines;`, ['open', 'Buffer'])(open, Buffer) as BoundedLines;
  return {bytes, reads, read: (maximumBytes = bytes.length) => read('synthetic-session.jsonl', bytes.length, maximumBytes),
    state: () => ({opens, closes})};
}

test('bounded session read preserves complete LF and CRLF records', async () => {
  for (const text of ['{"one":1}\n{"two":2}\n', '{"one":1}\r\n{"two":2}\r\n']) {
    const f = fixture(text);
    assert.deepEqual(await f.read(), {lines: ['{"one":1}', '{"two":2}'], tailOffset: null});
    assert.deepEqual(f.state(), {opens: 1, closes: 1});
  }
});

test('bounded session read fills legal short reads without zero padding or record loss', async () => {
  const text = '{"one":"synthetic"}\r\n{"two":2}\r\n';
  for (const chunk of [1, 2, 7]) {
    const f = fixture(text, {chunk});
    assert.deepEqual(await f.read(), {lines: ['{"one":"synthetic"}', '{"two":2}'], tailOffset: null});
    assert.equal(f.reads.reduce((sum, call) => sum + call.bytesRead, 0), f.bytes.length);
    assert.deepEqual(f.state(), {opens: 1, closes: 1});
  }
});

test('bounded session read assembles multibyte UTF8 before decoding short chunks', async () => {
  const text = '{"text":"\u03bb\ud83d\ude80"}\n';
  const f = fixture(text, {chunk: 1});
  assert.deepEqual(await f.read(), {lines: [text.trim()], tailOffset: null});
  assert.deepEqual(f.state(), {opens: 1, closes: 1});
});

test('bounded head and tail reads preserve their exact ranges during short reads', async () => {
  const text = Array.from({length: 20}, (_, n) => JSON.stringify({record: n})).join('\n') + '\n';
  const maximumBytes = 80;
  const expected = await fixture(text).read(maximumBytes);
  const f = fixture(text, {chunk: 3});
  assert.deepEqual(await f.read(maximumBytes), expected);
  const headEnd = maximumBytes / 2, tailStart = f.bytes.length - maximumBytes / 2;
  assert.ok(f.reads.every(call => call.position >= 0 &&
    (call.position + call.length <= headEnd || call.position >= tailStart && call.position + call.length <= f.bytes.length)));
  assert.equal(f.reads.reduce((sum, call) => sum + call.bytesRead, 0), maximumBytes);
  assert.deepEqual(f.state(), {opens: 1, closes: 1});
});

test('premature EOF fails closed instead of parsing a zero-padded buffer', async () => {
  for (const eofAt of [0, 5, 10]) {
    const f = fixture('{"one":1}\n{"two":2}\n', {chunk: 3, eofAt});
    await assert.rejects(f.read(), {message: 'provider_session_source_changed'});
    assert.equal(f.reads.filter(call => call.bytesRead === 0).length, 1);
    assert.deepEqual(f.state(), {opens: 1, closes: 1});
  }
});

test('premature EOF in the selected tail fails without reading another source', async () => {
  const f = fixture('synthetic line\n'.repeat(20), {chunk: 3, eofAt: 200});
  await assert.rejects(f.read(80), {message: 'provider_session_source_changed'});
  assert.deepEqual(f.state(), {opens: 1, closes: 1});
});

test('read failures close once and are not retried or normalized into empty evidence', async () => {
  for (const errorAt of [0, 1]) {
    const f = fixture('{"one":1}\n', {chunk: 2, errorAt});
    await assert.rejects(f.read(), {message: 'synthetic read failure'});
    assert.equal(f.reads.length, errorAt);
    assert.deepEqual(f.state(), {opens: 1, closes: 1});
  }
});

test('empty session files do not cause a nonprogress read loop', async () => {
  const f = fixture('', {chunk: 1});
  assert.deepEqual(await f.read(), {lines: [], tailOffset: null});
  assert.deepEqual(f.state(), {opens: 1, closes: 1});
});
