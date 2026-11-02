import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as usage from './usage.js';

async function dispatcher() {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['parseCliOptions', 'requireExplicitConfirmation', 'runOrganizationCommand', 'run'];
  const declarations = names.map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, name);
    return matches[0]!.getText(source);
  });
  const compiled = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const calls: string[] = [];
  const forbidden = () => { throw new Error('unexpected_effect'); };
  const run = runInNewContext(`${compiled.outputText}\nrun`, {
    // The dispatcher's pure usage text helpers; every effect below stays a spy or forbidden.
    exports: {}, ...usage, USAGE: 'unsupported_command', currentBootstrapHostScope: () => undefined,
    providerAdapters: [{ capability: async () => { calls.push('capability'); return { providerId: 'claude' }; } }],
    receiptAwareProviderCapabilities: async (value: unknown) => { calls.push('receiver'); return value; },
    organizationApi: async () => ({
      listTasks: async () => { calls.push('list'); return { route: 'list' }; },
      dispatchTask: async () => { calls.push('dispatch'); return { route: 'dispatch' }; },
    }),
    commandJsonBody: async () => { calls.push('body'); return {}; },
    runOneTask: async () => { calls.push('run-once'); return { route: 'run-once' }; },
    fetch: forbidden, readDeviceConfig: forbidden, registry: forbidden,
    loadDeviceEnrollmentAnchor: forbidden, writeFile: forbidden, execFileAsync: forbidden,
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (
    argv: string[],
  ) => Promise<unknown>;
  return { run, calls };
}

function section(document: string, name: string): string {
  const header = `## ${name}\n`;
  const start = document.indexOf(header);
  assert.notEqual(start, -1, name);
  const end = document.indexOf('\n## ', start + header.length);
  return document.slice(start + header.length, end < 0 ? undefined : end);
}

test('documented provider and task examples reach their actual dispatcher branches', async () => {
  const document = (await readFile(new URL('../../../docs/22-cli-command-contract.md', import.meta.url), 'utf8'))
    .replaceAll('\r\n', '\n');
  const examples = ['Providers', 'Tasks'].flatMap(name => section(document, name).split('\n')
    .filter(line => line.startsWith('dharma ')).map(line => line.slice('dharma '.length).split(/\s+/)));
  assert.ok(examples.length >= 3);
  for (const argv of examples) {
    const f = await dispatcher();
    await assert.doesNotReject(() => f.run(argv), argv.join(' '));
    assert.ok(f.calls.length > 0, argv.join(' '));
  }
});

test('provider example does not advertise an ignored workspace selector as route binding', async () => {
  const document = (await readFile(new URL('../../../docs/22-cli-command-contract.md', import.meta.url), 'utf8'))
    .replaceAll('\r\n', '\n');
  const examples = section(document, 'Providers').split('\n').filter(line => line.startsWith('dharma '));
  assert.deepEqual(examples, ['dharma providers list --json']);
});

test('unsupported provider and task spellings cannot reach provider or task effects', async () => {
  for (const argv of [
    ['providers', 'probe', 'claude'], ['providers', 'smoke', 'claude'],
    ...['inspect', 'accept', 'reject', 'send', 'cancel'].map(verb => ['tasks', verb, 'synthetic-task']),
  ]) {
    const f = await dispatcher();
    await assert.rejects(() => f.run(argv), /unsupported_command/);
    assert.deepEqual(f.calls, []);
  }
});

test('supported task dispatch still requires the actual explicit confirmation guard', async () => {
  for (const options of [[], ['--yes'], ['--confirm=false'], ['--confirm=true']]) {
    const f = await dispatcher();
    await assert.rejects(() => f.run(['tasks', 'dispatch', ...options]), /requires --confirm/);
    assert.deepEqual(f.calls, []);
  }
  const f = await dispatcher();
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run(['tasks', 'dispatch', '--confirm']))), { route: 'dispatch' });
  assert.deepEqual(f.calls, ['body', 'dispatch']);
});

test('provider capability and task list are separate from task execution', async () => {
  const providers = await dispatcher();
  await providers.run(['providers', 'list']);
  assert.deepEqual(providers.calls, ['capability', 'receiver']);
  const tasks = await dispatcher();
  await tasks.run(['tasks', 'list']);
  assert.deepEqual(tasks.calls, ['list']);
  const runner = await dispatcher();
  await runner.run(['tasks', 'run-once', '--policy', '/synthetic/approved-policy.json']);
  assert.deepEqual(runner.calls, ['run-once']);
});

test('task runner help prints its usage without reaching the task runner', async () => {
  for (const argv of [['tasks', 'run-once', '--policy', '/synthetic/approved-policy.json', '-h'],
    ['tasks', 'run-once', '-h'], ['tasks', 'run-once', '--help']]) {
    const f = await dispatcher();
    const output = await f.run(argv);
    assert.deepEqual(f.calls, [], argv.join(' '));
    assert.match(String(output), /^Usage: dharma tasks run-once --policy /, argv.join(' '));
  }
});
