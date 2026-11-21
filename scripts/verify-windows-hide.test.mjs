import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { findMissingWindowsHide, pinnedPublishers, scanRepository } from './verify-windows-hide.mjs';

// On Windows a console child started without `windowsHide: true` from a process
// that has no console (a background agent, a scheduled task, the relay
// supervisor) opens a visible terminal window that takes focus.
const repository = resolve(import.meta.dirname, '..');
const lines = (source, fileName) => findMissingWindowsHide(source, fileName).map(({ line, kind, name }) => `${line}:${kind}:${name}`);

test('every child process started from apps, packages, plugins and scripts hides its window', () => {
  const missing = scanRepository(repository).map(({ file, line, kind, name, text }) => `${file}:${line}: ${kind} ${name}: ${text}`);
  assert.deepEqual(missing, []);
});

test('only release publishers pinned by hash in a Linux publication workflow are exempt', () => {
  const workflows = ['publish.yml', 'publish-security-recovery.yml', 'publish-signing-upgrade.yml']
    .map((name) => readFileSync(resolve(repository, '.github/workflows', name), 'utf8'));
  for (const path of pinnedPublishers) {
    const pinning = workflows.filter((text) => text.includes(path.replace('scripts/', '')) && /_PUBLISHER_SHA256:\s*[a-f0-9]{64}/.test(text));
    assert.ok(pinning.length > 0, `${path} is not hash-pinned by a publication workflow`);
    assert.ok(pinning.every((text) => /runs-on:\s*ubuntu-latest/.test(text) && !/runs-on:\s*windows/.test(text)), `${path} may run on Windows`);
  }
  assert.equal(pinnedPublishers.size, 3);
});

test('the guard runs as part of npm run check', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  assert.equal(scripts['windows-hide:check'], 'node --test scripts/verify-windows-hide.test.mjs');
  assert.ok(scripts.check.includes('npm run windows-hide:check'));
});

test('named, renamed, namespace, default and dynamic imports are all checked', () => {
  const source = [
    "import { spawn, execFileSync as runSync } from 'node:child_process';",
    "import * as childProcess from 'child_process';",
    "import cp from 'node:child_process';",
    "spawn('git', ['status']);",
    "runSync('git', ['status'], { encoding: 'utf8' });",
    "childProcess.exec('dir');",
    "cp.fork('worker.js');",
    'async function late() {',
    "  const { spawnSync } = await import('node:child_process');",
    "  const loaded = require('node:child_process');",
    "  spawnSync('node', ['-v']);",
    "  loaded.execSync('ver', { stdio: 'pipe' });",
    '}',
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), [
    '4:call:spawn', '5:call:execFileSync', '6:call:exec', '7:call:fork', '11:call:spawnSync', '12:call:execSync',
  ]);
});

test('calls that pass windowsHide: true in an options literal pass, including spread options', () => {
  const source = [
    "import { spawn, execFile } from 'node:child_process';",
    "spawn('git', ['status'], { stdio: 'ignore', windowsHide: true });",
    "spawn('git', { windowsHide: true });",
    'const options = { cwd: "." };',
    "execFile('git', ['status'], { ...options, windowsHide: true }, () => {});",
    "execFile('git', ['status'], options, () => {});",
    "spawn('git', [], { windowsHide: false });",
    "spawn('git', [], { windowsHide: process.platform === 'win32' });",
    "spawn('git', [], fast ? { timeout: 1, windowsHide: true } : { windowsHide: true });",
    "spawn('git', [], fast ? { timeout: 1, windowsHide: true } : { timeout: 2 });",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.mjs'), ['6:call:execFile', '7:call:spawn', '8:call:spawn', '10:call:spawn']);
});

test('promisified and aliased process functions are checked where they are called', () => {
  const source = [
    "import { execFile } from 'node:child_process';",
    "import * as childProcess from 'node:child_process';",
    "import { promisify } from 'node:util';",
    'const run = promisify(execFile);',
    "await run('git', ['status']);",
    "await run('git', ['status'], { windowsHide: true });",
    "await promisify(execFile)('git', ['status']);",
    'const original = childProcess.spawn;',
    "original('git', [], options);",
    "original('git', [], { ...options, windowsHide: true });",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), ['5:call:execFile', '7:call:execFile', '9:call:spawn']);
});

test('a process function passed on as a value is reported, because its options cannot be checked', () => {
  const source = [
    "import { spawnSync } from 'node:child_process';",
    "import * as childProcess from 'node:child_process';",
    "import { promisify } from 'node:util';",
    'function launch(run = spawnSync) { return run; }',
    'const dependencies = { spawnSync };',
    'register(childProcess.spawn);',
    'register(promisify(spawnSync));',
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), [
    '4:reference:spawnSync', '5:reference:spawnSync', '6:reference:spawn', '7:reference:spawnSync',
  ]);
});

test('local names that shadow an import, unrelated exec methods and type positions are not reported', () => {
  const source = [
    "import { spawn, exec, type ChildProcess } from 'node:child_process';",
    'function run(spawn: (command: string) => ChildProcess) { return spawn("git"); }',
    "const exec2 = /x/.exec('x');",
    'type Spawner = typeof spawn;',
    "const wrapped = (command: string, args: string[]) => spawn(command, args, { windowsHide: true });",
    "process.stdout.write('spawn(no options)');",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), []);
});

test('a file without child_process imports is not reported', () => {
  assert.deepEqual(lines("function spawn() {}\nspawn('git');", 'fixture.js'), []);
});

test('a fallback around a property read on a dynamic import is checked where it is called', () => {
  const source = [
    "type Probe = (command: string, argv: string[], options: object) => unknown;",
    'export async function version(probe?: Probe) {',
    "  const run = probe || (await import('node:child_process')).spawnSync;",
    "  run('codex', ['--version'], { encoding: 'utf8', timeout: 5_000 });",
    "  const hidden = probe ?? (await import('node:child_process')).spawnSync;",
    "  hidden('codex', ['--version'], { encoding: 'utf8', windowsHide: true });",
    "  const either = probe ? probe : require('node:child_process').execFileSync;",
    "  either('codex', ['--version']);",
    '}',
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), ['4:call:spawnSync', '8:call:execFileSync']);
});

test('property and element reads on a load expression or a namespace are process functions', () => {
  const source = [
    "import * as childProcess from 'node:child_process';",
    "require('node:child_process').execSync('ver');",
    "(await import('child_process')).spawn('git');",
    "childProcess['spawn']('git');",
    "childProcess[\"execFileSync\"]('git', [], { windowsHide: true });",
    "require('node:child_process')['fork']('worker.js');",
    "(fast ? childProcess.spawnSync : require('node:child_process').spawnSync)('git');",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), [
    '2:call:execSync', '3:call:spawn', '4:call:spawn', '6:call:fork', '7:call:spawnSync',
  ]);
});

test('names destructured from a namespace are process functions', () => {
  const source = [
    "import * as childProcess from 'node:child_process';",
    'const { spawn, execFile: run, ChildProcess } = childProcess;',
    "spawn('git');",
    "run('git', [], { windowsHide: true });",
    'const loaded = require("node:child_process");',
    'const { execSync } = loaded;',
    "execSync('ver');",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), ['3:call:spawn', '7:call:execSync']);
});

test('a namespace or a load expression used as a value is reported', () => {
  const source = [
    "import * as childProcess from 'node:child_process';",
    'const cp = childProcess;',
    'register(childProcess);',
    'register({ childProcess });',
    "register(require('node:child_process'));",
    'export default childProcess;',
    'const kind: typeof childProcess.ChildProcess = childProcess.ChildProcess;',
    "t.mock.method(childProcess, 'spawn', (command: string) => childProcess.spawn(command, { windowsHide: true }));",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), [
    '2:reference:child_process', '3:reference:child_process', '4:reference:child_process',
    '5:reference:child_process', '6:reference:child_process',
  ]);
});

test('re-exported process functions and modules are reported', () => {
  const source = [
    "export { spawn } from 'node:child_process';",
    "export { execFile as run, ChildProcess } from 'child_process';",
    "export * from 'node:child_process';",
    "export * as childProcess from 'node:child_process';",
    "import { fork } from 'node:child_process';",
    'export { fork };',
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.ts'), [
    '1:reference:spawn', '2:reference:execFile', '3:reference:child_process', '4:reference:child_process',
    '6:reference:fork',
  ]);
});

test('createRequire bound to any name loads child_process', () => {
  const source = [
    "import { createRequire } from 'node:module';",
    'const load = createRequire(import.meta.url);',
    "const cp = load('node:child_process');",
    "cp.spawnSync('git');",
    "createRequire(import.meta.url)('child_process').execSync('ver');",
    "const { exec } = load('child_process');",
    "exec('dir', { windowsHide: true });",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.mjs'), ['4:call:spawnSync', '5:call:execSync']);
});

test('windowsHide passes only when no later spread or property can override it', () => {
  const source = [
    "import { spawn } from 'node:child_process';",
    "spawn('git', [], { windowsHide: true, ...options });",
    "spawn('git', [], { ...options, windowsHide: true, stdio: 'ignore' });",
    "spawn('git', [], { windowsHide: true, ...{ windowsHide: false } });",
    "spawn('git', [], { ...first, windowsHide: true, cwd: '.', });",
    "spawn('git', [], { windowsHide: true, ...(cwd === undefined ? {} : { cwd }) });",
    "spawn('git', [], { windowsHide: true, ...(cwd === undefined ? {} : options) });",
    "spawn('git', [], { windowsHide: true, ...{ cwd, ...options } });",
  ].join('\n');
  assert.deepEqual(lines(source, 'fixture.mjs'), ['2:call:spawn', '4:call:spawn', '7:call:spawn', '8:call:spawn']);
});
