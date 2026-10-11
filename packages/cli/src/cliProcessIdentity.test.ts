import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {verifiedCliProcessArguments, matchingCliExecutable} from './cliProcessIdentity.js';
import {readContainerProcessIdentity, type ContainerProcessIdentity} from './containerRelayLifecycle.js';

const trustedIndex = pathToFileURL(resolve('/trusted/dist/index.js')).href;
function fixture() {
  const identity: ContainerProcessIdentity = {pid: 101, uid: 1000, parentPid: 100,
    processGroupId: 101, sessionId: 101, startTicks: '123',
    argv: ['node', resolve('/cache/first/node_modules/.bin/dharma'), 'relay', 'supervise', '--policy', resolve('/workspace/.dharma/policy.json')]};
  const node = resolve('/runtime/node'), bin = resolve('/cache/second/node_modules/@dharma-ai-labs/agent-fabric/dist/bin.js');
  let reads = 0;
  const observed = structuredClone(identity);
  const runtime = {
    uid: 1000, execPath: node,
    identity: async (pid: number) => {assert.equal(pid, 101); reads++; return structuredClone(observed);},
    resolve: async (path: string): Promise<string> => {
      if (path === '/proc/101/exe' || path === node) return node;
      if (path === identity.argv[1]) return bin;
      throw new Error('fixture_path_unavailable');
    },
    executableMatches: async (pid: number, caller: string, uid: number) => {
      assert.equal(pid, 101);assert.equal(caller, node);assert.equal(uid, 1000);return true;
    },
    verifyRuntime: async (candidate: string, caller: string) => {
      assert.equal(candidate, bin);assert.equal(caller, resolve('/trusted/dist/bin.js'));return candidate;
    },
  };
  return {identity, observed, runtime, node, bin, reads: () => reads};
}

test('npm node and dharma aliases normalize only after executable/artifact verification', async () => {
  const f = fixture();
  assert.deepEqual(await verifiedCliProcessArguments(f.identity, trustedIndex, f.runtime),
    [f.node, resolve('/trusted/dist/bin.js'), ...f.identity.argv.slice(2)]);
  assert.equal(f.reads(), 2);
});

test('an absolute command must resolve to the actual live executable', async () => {
  const f = fixture();f.identity.argv[0] = f.node;f.observed.argv[0] = f.node;
  assert.ok(await verifiedCliProcessArguments(f.identity, trustedIndex, f.runtime));
  f.runtime.resolve = async path => path === '/proc/101/exe' ? f.node : '/foreign/node';
  assert.equal(await verifiedCliProcessArguments(f.identity, trustedIndex, f.runtime), null);
});

for (const change of ['uid','root','pid','creation','command','relative-script','foreign-runtime','foreign-artifact',
  'unknown-script','pid-reuse','script-drift','executable-drift','unavailable'] as const) {
  test(`npm aliases remain fail-closed for ${change}`, async () => {
    const f = fixture();
    if (change === 'uid') f.identity.uid = 999;
    if (change === 'root') f.runtime.uid = 0;
    if (change === 'pid') f.identity.pid = 0;
    if (change === 'creation') f.identity.startTicks = 'invalid';
    if (change === 'command') {f.identity.argv[0] = 'python';f.observed.argv[0] = 'python';}
    if (change === 'relative-script') {f.identity.argv[1] = '.bin/dharma';f.observed.argv[1] = '.bin/dharma';}
    if (change === 'foreign-runtime') f.runtime.executableMatches = async () => false;
    if (change === 'foreign-artifact') f.runtime.verifyRuntime = async () => {throw new Error('different-version-or-bytes');};
    if (change === 'unknown-script') f.runtime.resolve = async path => path === '/proc/101/exe' ? f.node : '/foreign/dist/foreign.js';
    if (change === 'pid-reuse') f.runtime.identity = async () => ({...f.observed, startTicks: '999'});
    if (change === 'script-drift') {
      let scripts = 0;const resolve = f.runtime.resolve;
      f.runtime.resolve = async path => path === f.identity.argv[1] && ++scripts > 1 ? '/foreign/dist/bin.js' : resolve(path);
    }
    if (change === 'executable-drift') {
      let executables = 0;const resolve = f.runtime.resolve;
      f.runtime.resolve = async path => path === '/proc/101/exe' && ++executables > 1 ? '/foreign/node' : resolve(path);
    }
    if (change === 'unavailable') f.runtime.identity = async () => {throw new Error('process-unavailable');};
    assert.equal(await verifiedCliProcessArguments(f.identity, trustedIndex, f.runtime), null);
  });
}

test('normalization preserves every action argument for the caller exact-tuple check', async () => {
  const f = fixture();f.identity.argv.push('--foreign');f.observed.argv.push('--foreign');
  const result = await verifiedCliProcessArguments(f.identity, trustedIndex, f.runtime);
  assert.equal(result?.at(-1), '--foreign');
});

test('live Linux executable verification uses loaded bytes, not argv names', {skip: process.platform !== 'linux'}, async () => {
  assert.equal(await matchingCliExecutable(process.pid, process.execPath, process.getuid!()), true);
  assert.equal(await matchingCliExecutable(process.pid, '/missing/node', process.getuid!()).catch(() => false), false);
});

test('real npm-style child requires matching verifier bytes across independent package prefixes',
  {skip: process.platform !== 'linux' || process.getuid?.() === 0, timeout: 15_000}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dharma-cli-identity-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const caller = join(root, 'caller'), candidate = join(root, 'candidate');
    const bin = "process.on('message',()=>process.exit(0));process.send('ready');\n";
    for (const prefix of [caller, candidate]) {
      await mkdir(join(prefix, 'dist'), {recursive: true});
      await writeFile(join(prefix, 'package.json'), JSON.stringify({name: '@dharma-ai-labs/agent-fabric', version: '0.0.0-test'}), {mode: 0o600});
      for (const [name, bytes] of Object.entries({'bin.js': bin, 'index.js': 'synthetic index',
        'containerRelayLifecycle.js': 'synthetic lifecycle', 'cliProcessIdentity.js': 'synthetic verifier'})) {
        await writeFile(join(prefix, 'dist', name), bytes, {mode: 0o600});
      }
    }
    const alias = join(root, '.bin', 'dharma');
    await mkdir(join(root, '.bin')); await symlink(join(candidate, 'dist', 'bin.js'), alias);
    const child = spawn(process.execPath, [alias, 'relay', 'supervise', '--policy', join(root, 'policy.json')],
      {argv0: 'node', stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.send('stop'); await exited;
      }
    });
    const [ready] = await once(child, 'message'); assert.equal(ready, 'ready');
    const identity = await readContainerProcessIdentity(child.pid!);
    assert.equal(identity.argv[0], 'node'); assert.equal(identity.argv[1], alias);
    const callerUrl = pathToFileURL(join(caller, 'dist', 'index.js')).href;
    const expected = [process.execPath, join(caller, 'dist', 'bin.js'), ...identity.argv.slice(2)];
    assert.deepEqual(await verifiedCliProcessArguments(identity, callerUrl), expected);
    await writeFile(join(candidate, 'dist', 'cliProcessIdentity.js'), 'altered verifier', {mode: 0o600});
    assert.equal(await verifiedCliProcessArguments(identity, callerUrl), null);
    await writeFile(join(candidate, 'dist', 'cliProcessIdentity.js'), 'synthetic verifier', {mode: 0o600});
    await chmod(join(candidate, 'dist', 'cliProcessIdentity.js'), 0o666);
    assert.equal(await verifiedCliProcessArguments(identity, callerUrl), null);
    await chmod(join(candidate, 'dist', 'cliProcessIdentity.js'), 0o600);
    assert.deepEqual(await verifiedCliProcessArguments(identity, callerUrl), expected);
    await writeFile(join(candidate, 'package.json'), JSON.stringify({name: '@dharma-ai-labs/agent-fabric', version: '0.0.1-foreign'}));
    assert.equal(await verifiedCliProcessArguments(identity, callerUrl), null);
  });
