import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import ts from 'typescript';

const PRIVATE_PATH = 'C:\\synthetic-private-path-token';
const PRIVATE_OUTPUT = 'synthetic-private-command-output-token';
const user = 'S-1-5-21-100-200-300-1000';
const privateAcl = { currentUserSid: user, ownerSid: user, daclPresent: true, daclNull: false,
  allowRules: [user, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, rights: 2032127, inheritOnly: false })) };

type Invocation = { file: string; args: string[]; options: Record<string, unknown> };
async function fixture(execute: (invocation: Invocation) => Promise<{ stdout: string }>) {
  const source = await readFile(new URL('../src/skillPreparationTransaction.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('skillPreparationTransaction.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['powershellEnvironment', 'assertWindowsSkillPreparationAcl',
    'windowsPreparationAclFailure', 'assertPrivatePath', 'hardenWindowsPrivateDirectory']);
  const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(node => names.has(node.name?.text || ''));
  const constants = ast.statements.filter(ts.isVariableStatement).filter(node =>
    node.declarationList.declarations.some(value => ['WINDOWS_ACL_TIMEOUT_MS', 'ACL_SCRIPT', 'PRIVATE_DIRECTORY_ACL_SCRIPT'].includes(value.name.getText(ast))));
  assert.equal(functions.filter(node => node.name?.text !== 'windowsPreparationAclFailure').length, 4,
    'exercise both real ACL operations and their environment and policy checks');
  assert.equal(constants.length, 3);
  const emitted = ts.transpileModule([...constants, ...functions].map(node => node.getText(ast)).join('\n')
    + '\nglobalThis.aclFixture = { assertPrivatePath, hardenWindowsPrivateDirectory };',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const calls: Invocation[] = [];
  const context = { exports: {}, process: { platform: 'win32', env: {
    SystemRoot: 'C:\\Windows', PATH: 'synthetic-path', TEMP: 'synthetic-temp', TMP: 'synthetic-tmp',
    PSModulePath: 'synthetic-modules', PRIVATE_UNRELATED: PRIVATE_OUTPUT,
  } }, execFileAsync: async (file: string, args: string[], options: Record<string, unknown>) => {
    const invocation = { file, args, options }; calls.push(invocation); return execute(invocation);
  }, aclFixture: undefined as unknown as {
    assertPrivatePath: (path: string, stat: unknown) => Promise<void>;
    hardenWindowsPrivateDirectory: (path: string) => Promise<void>;
  } };
  new Script(emitted).runInNewContext(context);
  return { calls, verify: () => context.aclFixture.assertPrivatePath(PRIVATE_PATH, {}),
    establish: () => context.aclFixture.hardenWindowsPrivateDirectory(PRIVATE_PATH) };
}

test('Windows ACL diagnostics retain the native command bounds and private policy on success', async () => {
  const f = await fixture(async () => ({ stdout: JSON.stringify(privateAcl) }));
  await f.verify(); await f.establish();
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.file, 'powershell.exe');
    assert.deepEqual(Array.from(call.args.slice(0, 4)), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(call.args.length, 5);
    assert.equal(call.options.timeout, 15000);
    assert.equal(call.options.maxBuffer, 65536);
    assert.equal(call.options.windowsHide, true);
    const env = call.options.env as Record<string, string>;
    assert.equal(env.DHARMA_PREPARATION_ACL_PATH, PRIVATE_PATH);
    assert.equal(env.PRIVATE_UNRELATED, undefined);
    assert.ok(!call.args.join(' ').includes(PRIVATE_PATH));
  }
});

for (const [category, fields] of [
  ['output-limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
  ['process-aborted', { code: 'ABORT_ERR' }],
  ['process-terminated', { killed: true, signal: 'SIGTERM' }],
  ['spawn-unavailable', { code: 'ENOENT' }],
  ['spawn-denied', { code: 'EACCES' }],
  ['spawn-denied', { code: 'EPERM' }],
  ['command-failed', { code: 1 }],
  ['command-failed', { code: 2147942405 }],
  ['unknown-process-failure', { code: PRIVATE_OUTPUT }],
  ['unknown-process-failure', {}],
] as const) {
  test(`Windows ACL ${category} is sanitized and never retries the failed command`, async () => {
    for (const operation of ['verify', 'establish'] as const) {
      const error = Object.assign(new Error(`${PRIVATE_PATH}: ${PRIVATE_OUTPUT}`), fields,
        { stdout: PRIVATE_OUTPUT, stderr: PRIVATE_OUTPUT, cmd: PRIVATE_PATH });
      const f = await fixture(async () => { throw error; });
      await assert.rejects(f[operation](), (failure: Error) => {
        assert.equal(failure.message, `Windows preparation private access could not be ${operation === 'verify' ? 'verified' : 'established'} (${category}).`);
        const serialized = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
        assert.ok(!serialized.includes(PRIVATE_PATH) && !serialized.includes(PRIVATE_OUTPUT));
        assert.equal((failure as Error & { cause?: unknown }).cause, undefined);
        return true;
      });
      assert.equal(f.calls.length, 1);
    }
  });
}

test('Windows ACL invalid output and rejected policy stay distinct from process failure', async () => {
  for (const [stdout, category] of [
    [PRIVATE_OUTPUT, 'invalid-output'],
    [JSON.stringify({ ...privateAcl, daclNull: true }), 'acl-rejected'],
    [JSON.stringify({ ...privateAcl, ownerSid: 'S-1-5-21-900-900-900-1000' }), 'acl-rejected'],
    [JSON.stringify({ ...privateAcl, allowRules: [...privateAcl.allowRules,
      { sid: 'S-1-5-32-545', rights: 1, inheritOnly: false }] }), 'acl-rejected'],
  ] as const) {
    const f = await fixture(async () => ({ stdout }));
    await assert.rejects(f.verify(), new RegExp(`could not be verified \\(${category}\\)\\.`));
    assert.equal(f.calls.length, 1);
  }
});
