import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {FileActionExecutionJournal} from './index.js';

type Scope = {signal: AbortSignal; current(): Promise<boolean>};
async function run(directory: string, scope?: Scope) {
  const journal = new FileActionExecutionJournal(directory);
  await (journal.selfTest as unknown as (scope?: Scope) => Promise<void>).call(journal, scope);
}
async function fixture(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'dharma-journal-scope-'));
  try {await operation(directory);} finally {await rm(directory, {recursive: true, force: true});}
}

test('journal rejects malformed supplied scopes and redacts accessors before filesystem effects', async () => {
  await fixture(async root => {
    const signal = new AbortController().signal;
    const throwingSignal = Object.defineProperty({}, 'signal', {get() {throw new Error('private-accessor-canary');}});
    const throwingCurrent = Object.defineProperty({signal}, 'current', {get() {throw new Error('private-accessor-canary');}});
    for (const scope of [null, false, 0, '', {}, throwingSignal, throwingCurrent]) {
      await assert.rejects(run(resolve(root, 'journal'), scope as unknown as Scope),
        {message: 'journal_self_test_scope_unavailable'});
      assert.deepEqual(await readdir(root), []);
    }
  });
});

test('journal scope fields are captured once without a supplied bind property', async () => {
  await fixture(async root => {
    let signals = 0, callbacks = 0;
    const signal = new AbortController().signal, current = async () => true;
    Object.defineProperty(current, 'bind', {get() {throw new Error('private-bind-canary');}});
    await run(resolve(root, 'journal'), {get signal() {signals++; return signal;}, get current() {callbacks++; return current;}});
    assert.equal(signals, 1); assert.equal(callbacks, 1);
  });
});

test('journal self-test denies cancelled or withdrawn authority before creating its directory', async () => {
  await fixture(async root => {
    for (const cancelled of [false, true]) {
      const abort = new AbortController(); if (cancelled) abort.abort();
      await assert.rejects(run(resolve(root, `journal-${cancelled}`), {signal: abort.signal, current: async () => cancelled}),
        {message: 'journal_self_test_scope_unavailable'});
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('journal self-test stops after a partial directory effect without opening a file', async () => {
  await fixture(async root => {
    const directory = resolve(root, 'journal'); let checks = 0;
    await assert.rejects(run(directory, {signal: new AbortController().signal, current: async () => ++checks < 2}),
      {message: 'journal_self_test_scope_unavailable'});
    assert.deepEqual(await readdir(directory), []); assert.equal(checks, 2);
  });
});

test('journal self-test closes its owned handle and does not publish after mid-operation withdrawal', async () => {
  for (const stopAt of [4, 6]) await fixture(async root => {
    const directory = resolve(root, 'journal'); let checks = 0;
    await assert.rejects(run(directory, {signal: new AbortController().signal, current: async () => ++checks < stopAt}),
      {message: 'journal_self_test_scope_unavailable'});
    const files = await readdir(directory); assert.equal(files.length, 1);
    assert.match(files[0]!, /\.tmp$/);
    const bytes = await readFile(resolve(directory, files[0]!));
    assert.equal(bytes.length > 0, stopAt === 6);
    assert.equal(checks, stopAt);
  });
});

test('journal directory-sync fallback cannot swallow withdrawal or admit cleanup', async () => {
  await fixture(async root => {
    const directory = resolve(root, 'journal'); let checks = 0;
    await assert.rejects(run(directory, {signal: new AbortController().signal, current: async () => ++checks < 12}),
      {message: 'journal_self_test_scope_unavailable'});
    const files = await readdir(directory); assert.equal(files.length, 1);
    assert.match(files[0]!, /^\.self-test-.*\.json$/);
    assert.equal(JSON.parse(await readFile(resolve(directory, files[0]!), 'utf8')).schema,
      'dharma.action-execution-journal-self-test/v1');
  });
});

test('journal self-test retains current-scoped and ordinary readback and cleanup', async () => {
  await fixture(async root => {
    for (const scoped of [false, true]) {
      const directory = resolve(root, `journal-${scoped}`);
      await run(directory, scoped ? {signal: new AbortController().signal, current: async () => true} : undefined);
      assert.deepEqual(await readdir(directory), []);
    }
  });
});

test('journal self-test does not disclose throwing or nonboolean qualification results', async () => {
  await fixture(async root => {
    for (const current of [async () => 'true', async () => {throw new Error('private-qualification-canary');}]) {
      await assert.rejects(run(resolve(root, 'journal'), {signal: new AbortController().signal, current} as unknown as Scope),
        {message: 'journal_self_test_scope_unavailable'});
    }
    assert.deepEqual(await readdir(root), []);
  });
});
