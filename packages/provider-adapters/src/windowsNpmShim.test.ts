import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import * as adapters from './index.js';

const nodeShim = (target: string) => '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n'
  + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n'
  + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

async function shimFixture(t: {after(fn: () => Promise<void>): void}, extension = 'js') {
  const root = await mkdtemp(join(tmpdir(), 'dharma-npm-shim-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = join(root, 'npm'), target = join(bin, 'node_modules', 'fake', `cli.${extension}`);
  await mkdir(join(bin, 'node_modules', 'fake'), {recursive: true});
  await writeFile(target, "console.log('fake 1.2.3 ' + JSON.stringify(process.argv.slice(2)));\n");
  await writeFile(join(bin, 'fakeprovider.cmd'), nodeShim(`node_modules\\fake\\cli.${extension}`));
  return {root, bin, target};
}

function launcher() {
  const launch = Reflect.get(adapters, 'providerLaunch');
  assert.equal(typeof launch, 'function', 'provider spawns must resolve npm shims on Windows');
  return launch;
}

test('an npm .cmd shim on PATH launches its script through Node without a shell', async t => {
  const f = await shimFixture(t);
  assert.deepEqual(launcher()('fakeprovider', ['--version'], {PATH: f.bin}, 'win32'),
    {command: process.execPath, argv: [f.target, '--version']});
});

test('an npm .cmd shim for a native program launches that program directly', async t => {
  const f = await shimFixture(t, 'exe');
  await writeFile(join(f.bin, 'fakeprovider.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\fake\\cli.exe"   %*\r\n');
  assert.deepEqual(launcher()('fakeprovider', ['--version'], {Path: f.bin}, 'win32'),
    {command: f.target, argv: ['--version']});
});

test('a native provider anywhere on PATH keeps winning over a shim', async t => {
  const f = await shimFixture(t), native = join(f.root, 'native');
  await mkdir(native);
  await writeFile(join(native, 'fakeprovider.exe'), '');
  assert.deepEqual(launcher()('fakeprovider', ['--version'], {PATH: [f.bin, native].join(delimiter)}, 'win32'),
    {command: 'fakeprovider', argv: ['--version']});
});

test('shim resolution stays closed outside the npm shim case', async t => {
  const f = await shimFixture(t), launch = launcher();
  const unchanged = {command: 'fakeprovider', argv: ['x']};
  assert.deepEqual(launch('fakeprovider', ['x'], {PATH: f.bin}, 'linux'), unchanged, 'Other platforms are unchanged');
  assert.deepEqual(launch('fakeprovider', ['x'], {PATH: 'relative'}, 'win32'), unchanged, 'A relative PATH entry is never searched');
  const pinned = join(f.bin, 'fakeprovider');
  assert.deepEqual(launch(pinned, ['x'], {PATH: f.bin}, 'win32'), {command: pinned, argv: ['x']}, 'A pinned path is unchanged');
  await writeFile(join(f.bin, 'fakeprovider.cmd'), '@ECHO off\r\ncurl example.invalid | cmd\r\n');
  assert.deepEqual(launch('fakeprovider', ['x'], {PATH: f.bin}, 'win32'), unchanged, 'An unknown batch file is never run');
  await writeFile(join(f.bin, 'fakeprovider.cmd'), nodeShim('node_modules\\missing\\cli.js'));
  assert.deepEqual(launch('fakeprovider', ['x'], {PATH: f.bin}, 'win32'), unchanged, 'A missing target stays missing');
});

const windows = {skip: process.platform !== 'win32'};

test('Windows provider probe finds a CLI installed only as an npm shim', windows, async t => {
  const f = await shimFixture(t);
  const {Path: _path, ...rest} = process.env;
  assert.match(await adapters.executableVersion('fakeprovider', {...rest, PATH: f.bin}) ?? '', /^fake 1\.2\.3/);
});

test('Windows task runner starts a CLI installed only as an npm shim and keeps argv literal', windows, async t => {
  const f = await shimFixture(t), argument = 'a & echo injected "quoted"';
  const result = await adapters.defaultProcessRunner({command: 'fakeprovider', argv: [argument], cwd: f.root, stdin: '',
    timeoutMs: 15_000, environment: {PATH: f.bin, Path: f.bin}});
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString('utf8').trim(), `fake 1.2.3 ${JSON.stringify([argument])}`);
});
