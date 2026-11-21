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
