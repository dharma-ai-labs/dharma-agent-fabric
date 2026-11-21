import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileFunction} from 'node:vm';
import test, {type TestContext} from 'node:test';
import ts from 'typescript';
import {enableRelayAutostart, relayAutostartStatus, disableRelayAutostart, startRelayAutostart,
  assertRelayStartupOwnership,assertRelayAutostartPaused} from './relayAutostart.js';
import {resolveWslRelayContext} from './wslRelayHost.js';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';

type PowerShellFixtureLaunch = (file: string, args: string[], options: {
  input?: string; encoding: 'utf8'; timeout: number; windowsHide: boolean; maxBuffer: number;
}) => {error?: Error; status: number | null; stdout: string; stderr: string};

const launchPowerShellFixture: PowerShellFixtureLaunch = (file, args, options) =>
  spawnSync(file, args, {...options, windowsHide: true});

function runPowerShellFixture(script: string, input?: string, launch: PowerShellFixtureLaunch = launchPowerShellFixture): string {
  // Cold CI fixture hosts need a separate budget; production interop stays at 15s.
  const result = launch('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    ...(input === undefined ? {} : {input}), encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16_384,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('PowerShell fixtures launch once with a bounded hidden test-only startup budget', () => {
  let calls = 0;
  const stdout = runPowerShellFixture('synthetic parser or mocked scheduler fixture', '{"fixture":true}', (file, args, options) => {
    calls++;
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(Buffer.from(args[4]!, 'base64').toString('utf16le'), 'synthetic parser or mocked scheduler fixture');
    assert.deepEqual(options, {input: '{"fixture":true}', encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16_384});
    return {status: 0, stdout: 'fixture-result', stderr: ''};
  });
  assert.equal(stdout, 'fixture-result'); assert.equal(calls, 1);
});

test('PowerShell fixture startup errors and timeouts fail explicitly without retry', () => {
  for (const code of ['ETIMEDOUT', 'ENOENT']) {
    let calls = 0;
    assert.throws(() => runPowerShellFixture('synthetic', undefined, () => {
      calls++; return {error: Object.assign(new Error('synthetic fixture startup failure'), {code}),
        status: null, stdout: '', stderr: ''};
    }), {code: 'ERR_ASSERTION'});
    assert.equal(calls, 1);
  }
});

test('PowerShell fixture nonzero exit never becomes a successful scheduler result', () => {
  let calls = 0;
  assert.throws(() => runPowerShellFixture('synthetic', undefined, () => {
    calls++; return {status: 1, stdout: 'absent', stderr: 'synthetic refusal'};
  }), {code: 'ERR_ASSERTION'});
  assert.equal(calls, 1);
});

test('real WSL Windows launch uses a fixed Windows cwd rather than the Linux caller directory', async () => {
  const source = await readFile(new URL('../src/wslRelayHost.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('wslRelayHost.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'windows');
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  const compiled = ts.transpileModule(declaration.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}}).outputText;
  let calls = 0;
  const launch = compileFunction(compiled + '\nreturn windows;',
    ['currentBootstrapHostScope', 'execFile', 'windowsArgs', 'captureBootstrapHostChild'])(
    () => undefined,
    (file: string, args: string[], options: {cwd?: string; timeout?: number; maxBuffer?: number},
      done: (error: Error | null, stdout: string) => void) => {
      calls++;
      assert.equal(file, '/init'); assert.deepEqual(args, ['public-arguments']);
      assert.equal(options.cwd, '/mnt/c/Windows/System32', 'Linux cwd must not become a Windows UNC current directory');
      assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 16384);
      done(null, '{"public":true}'); return {};
    }, () => ['public-arguments'], () => {throw new Error('no setup scope in this fixture');});
  assert.deepEqual(await launch('public-script'), {stdout: '{"public":true}'});
  assert.equal(calls, 1);
});

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-wsl-host-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const scripts: string[] = [];
  let exists = false;
  let enabled = false;
  let running = false;
  let loseRegistrationResponse = false;
  let legacy = false;
  let systemdEnabled=true;
  const options = {platform: 'linux' as const, home: join(root, 'device'), userHome: root,
    workspace: '/fixtures/repo', launcher: '/fixtures/repo/.dharma/bin/dharma',
    policy: '/fixtures/repo/.dharma/approved-policy.json', version: '0.2.198',
    run: async (_file:string,args:string[]) => {
      if(args.includes('enable'))systemdEnabled=true;if(args.includes('disable'))systemdEnabled=false;
      return {stdout:(args.includes('is-active')?'inactive':systemdEnabled?'enabled':'disabled')+'\n'};
    },
    wslHost: {
      context: async () => ({distribution: 'Ubuntu', linuxUser: 'maatru'}),
      run: async (script: string) => {
        scripts.push(script);
        if (script.includes('dharma-wsl-host:identity')) return {stdout: JSON.stringify({
          sid: 'S-1-5-21-123-456-789-1001', executable: 'C:\\Windows\\System32\\wsl.exe'})};
        if (script.includes('dharma-wsl-host:register')) {
          exists = true;
          enabled = true;
          // The task holds the action the registration asked for: PowerShell itself is the earlier action.
          legacy = /New-ScheduledTaskAction -Execute '[^']*\\powershell\.exe'/.test(script);
          if (loseRegistrationResponse) throw new Error('registration response lost');
        }
        if (script.includes('dharma-wsl-host:start')) running = true;
        if (script.includes('dharma-wsl-host:disable')) {exists = false;enabled=false;running = false;}
        if (script.includes('dharma-wsl-host:pause')) enabled=false;
        return {stdout: JSON.stringify({exists, enabled, running, ...(legacy ? {legacy} : {})})};
      },
    },
  };
  return {options, scripts, foreignTask: () => {exists = true;enabled=true;}, loseResponse: () => {loseRegistrationResponse = true;},
    legacyTask: () => {exists = true;enabled = true;legacy = true;}};
}

test('WSL pause preserves its exact owned host receipt and remains independently verifiable',async t=>{
  const f=await fixture(t);let state='enabled';
  const options={...f.options,run:async(_file:string,args:string[])=>{
    if(args.includes('disable'))state='disabled';return{stdout:(args.includes('is-active')?'inactive':state)+'\n'};}};
  await enableRelayAutostart(options);
  const receipt=await readFile(join(options.home,'relay','wsl-host.json'),'utf8');
  await enableRelayAutostart({...options,pauseForSigningMaintenance:true});
  assert.equal(await readFile(join(options.home,'relay','wsl-host.json'),'utf8'),receipt);
  await assertRelayAutostartPaused(options);
  assert(!f.scripts.some(s=>s.includes('dharma-wsl-host:start')));
});

test('WSL pause verification rejects an unreceipted task and never converts denial to absence',async t=>{
  const f=await fixture(t);let state='enabled';
  const options={...f.options,run:async(_file:string,args:string[])=>{
    if(args.includes('disable'))state='disabled';return{stdout:(args.includes('is-active')?'inactive':state)+'\n'};}};
  await enableRelayAutostart(options);await enableRelayAutostart({...options,pauseForSigningMaintenance:true});
  await rm(join(options.home,'relay','wsl-host.json'));
  f.foreignTask();await assert.rejects(assertRelayAutostartPaused(options),/autostart_conflict/);
  const original=options.wslHost.run;
  let deniedReads=0;
  const denied={...options,wslHost:{...options.wslHost,run:async(script:string)=>{
    if(script.includes('dharma-wsl-host:status')){deniedReads++;throw Error('scheduler read denied fixture');}return original(script);}}};
  await assert.rejects(assertRelayAutostartPaused(denied),/wsl_host_startup_unavailable/);
  assert.equal(deniedReads,1);
});

test('WSL receipt-backed context survives maintenance pause when the environment has no distro name',async t=>{
  const f=await fixture(t);let state='enabled';
  const original={...f.options,run:async(_file:string,args:string[])=>{
    if(args.includes('disable'))state='disabled';return{stdout:(args.includes('is-active')?'inactive':state)+'\n'};}};
  await enableRelayAutostart(original);
  const receiptPath=join(original.home,'relay','wsl-host.json'),before=await readFile(receiptPath,'utf8');
  const options={...original,wslHost:{...original.wslHost,context:async()=>resolveWslRelayContext(undefined,'maatru',
    JSON.parse(await readFile(receiptPath,'utf8')))}};
  await enableRelayAutostart({...options,pauseForSigningMaintenance:true});await assertRelayAutostartPaused(options);
  assert.equal(await readFile(receiptPath,'utf8'),before);
  assert(f.scripts.some(s=>s.includes('dharma-wsl-host:pause')));
  assert(!f.scripts.some(s=>s.includes('dharma-wsl-host:disable')));
});

test('maintenance pause never disables or unregisters an owned host task that is still running',async t=>{
  const f=await fixture(t);await enableRelayAutostart(f.options);await startRelayAutostart(f.options);
  const before=f.scripts.length;
  await assert.rejects(enableRelayAutostart({...f.options,pauseForSigningMaintenance:true}),/wsl_host_startup_unavailable/);
  assert(!f.scripts.slice(before).some(s=>/dharma-wsl-host:(pause|disable)/.test(s)));
});

function registeredTaskAction(scripts: string[]) {
  const registration = scripts.find(script => script.includes('dharma-wsl-host:register'))!;
  const match = /New-ScheduledTaskAction -Execute '([^']+)' -Argument '([^']+)'/.exec(registration);
  assert.ok(match, 'expected one fixed task action');
  return {execute: match[1]!, arguments: match[2]!};
}

test('WSL task uses the verified PowerShell host under a headless console host for its fixed native wait action', async t => {
  const f = await fixture(t); await enableRelayAutostart(f.options);
  const action = registeredTaskAction(f.scripts);
  // No console window opens at logon, and none can be closed to stop the WSL host. Both programs are absolute paths.
  assert.equal(action.execute, 'C:\\Windows\\System32\\conhost.exe');
  assert.match(action.arguments, /^--headless C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(action.arguments.split(' ').at(-1)!, 'base64').toString('utf16le');
  assert.equal(script, "$ErrorActionPreference='Stop'; & 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ubuntu' --user 'maatru' --cd / --exec /usr/bin/systemctl --user start --wait dharma-agent-fabric.service; exit $LASTEXITCODE");
  assert.doesNotMatch(script, /ExecutionPolicy|credential|password|token|grant|Start-Process|Invoke-Expression/i);
});

test('an owned WSL host task with the earlier PowerShell action gets the headless action at the next registration', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  f.legacyTask();
  const before = f.scripts.length;
  await enableRelayAutostart(f.options);
  const registration = f.scripts.slice(before).find(script => script.includes('dharma-wsl-host:register'));
  assert.ok(registration, 'an enabled owned task with the earlier action is registered again');
  assert.equal(registeredTaskAction([registration]).execute, 'C:\\Windows\\System32\\conhost.exe');
  // The owned task keeps its definition and only its action is replaced.
  assert.match(registration, /if \(Test-LegacyAction \$task\) \{ Set-ScheduledTask -TaskPath '\\' -TaskName '[^']+' -Action \$action\|Out-Null \}; /);
  assert.doesNotMatch(registration, /Unregister-ScheduledTask|-Force/);
  // A task that already has the headless action is left as it is.
  const after = f.scripts.length;
  await enableRelayAutostart(f.options);
  assert(!f.scripts.slice(after).some(script => script.includes('dharma-wsl-host:register')));
});

test('a WSL rollback restores the earlier PowerShell action that the restored release owns', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  assert.equal(registeredTaskAction(f.scripts).execute, 'C:\\Windows\\System32\\conhost.exe');
  // Releases before 0.2.226 own only the earlier action and refuse the headless one as a conflict.
  const before = f.scripts.length;
  assert.equal((await enableRelayAutostart({...f.options, version: '0.2.225', restoreCodexHome: null})).state, 'enabled');
  const restored = f.scripts.slice(before).find(script => script.includes('dharma-wsl-host:register'));
  assert.ok(restored, 'the rollback registers the earlier action again');
  const action = registeredTaskAction([restored]);
  assert.equal(action.execute, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(action.arguments, /^-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  // The owned task keeps its definition and only its action is replaced.
  assert.match(restored, /if \(-not \(Test-LegacyAction \$task\)\) \{ Set-ScheduledTask -TaskPath '\\' -TaskName '[^']+' -Action \$action\|Out-Null \}; /);
  assert.doesNotMatch(restored, /Unregister-ScheduledTask|-Force/);
  // A rollback to a release that owns the headless action registers that action.
  const after = f.scripts.length;
  await enableRelayAutostart({...f.options, version: '0.2.226', restoreCodexHome: null});
  const forward = f.scripts.slice(after).find(script => script.includes('dharma-wsl-host:register'));
  assert.ok(forward);
  assert.equal(registeredTaskAction([forward]).execute, 'C:\\Windows\\System32\\conhost.exe');
});

// Starts a task action from Node with its argument text passed as it is and with piped standard
// handles, and waits for the marker file its client writes. Piped handles put the headless console
// host in pseudoconsole mode: it reads terminal input from its standard input and closes the
// console when that input ends, so the input pipe stays open until the client is done. Task
// Scheduler gives the action no standard handles; runTaskActionWithoutHandles covers that mode.
async function runTaskAction(execute: string, argumentsLine: string, cwd: string, marker: string) {
  const child = spawn(execute, [argumentsLine], {cwd, windowsHide: true, windowsVerbatimArguments: true});
  let output = '';
  child.stdout.on('data', chunk => {output += chunk;});
  child.stderr.on('data', chunk => {output += chunk;});
  let exited = false;
  const exit = new Promise<number | null>((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => {exited = true; accept(code);});
  });
  let content: string | null = null;
  for (let attempt = 0; attempt < 300 && content === null; attempt++) {
    content = await readFile(marker, 'utf8').catch(() => null);
    if (content === null) await new Promise(accept => setTimeout(accept, 100));
  }
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await exit.finally(() => clearTimeout(timer));
  return {content, code, exitedBeforeMarker: content === null && exited, output};
}

// Starts a task action through Win32_Process.Create, which gives the new process no standard
// handles and no console of a parent, as Task Scheduler does at logon. The client writes a
// heartbeat about once a second and then a done marker. The heartbeats are sampled while the
// console host is checked to be still running, and the host must exit once the client is done.
async function runTaskActionWithoutHandles(execute: string, argumentsLine: string, cwd: string, heartbeat: string, done: string) {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const create = `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{`
    + `CommandLine = ${literal(`"${execute}" ${argumentsLine}`)}; CurrentDirectory = ${literal(cwd)}}; `
    + 'if ($created.ReturnValue -ne 0) {throw "Win32_Process.Create returned $($created.ReturnValue)"}; '
    + '[Console]::Out.Write($created.ProcessId)';
  const started = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(create, 'utf16le').toString('base64')], {encoding: 'utf8', timeout: 60_000, windowsHide: true});
  if (started.error || started.status !== 0) throw new Error(`${started.stderr || started.error}`);
  const pid = Number(started.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, started.stdout);
  const alive = () => {try {process.kill(pid, 0); return true;} catch {return false;}};
  const isDone = () => readFile(done, 'utf8').then(() => true, () => false);
  const beats: string[] = [];
  let finished = false;
  let hostStoppedEarly = false;
  try {
    for (const deadline = Date.now() + 60_000; !finished && !hostStoppedEarly && Date.now() < deadline;) {
      finished = await isDone();
      const beat = (await readFile(heartbeat, 'utf8').catch(() => '')).trim();
      if (beat && beat !== beats.at(-1)) beats.push(beat);
      if (!finished && !alive()) {
        finished = await isDone();
        hostStoppedEarly = !finished;
      }
      if (!finished) await new Promise(accept => setTimeout(accept, 200));
    }
    let hostExited = !alive();
    for (const deadline = Date.now() + 15_000; finished && !hostExited && Date.now() < deadline;) {
      await new Promise(accept => setTimeout(accept, 200));
      hostExited = !alive();
    }
    return {beats, finished, hostStoppedEarly, hostExited};
  } finally {
    if (alive()) process.kill(pid);
  }
}

// A client that stays alive for about ten seconds and writes a heartbeat about once a second.
function heartbeatScript(heartbeat: string, done: string, separator: string) {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return [`for ($beat = 1; $beat -le 10; $beat++) {[System.IO.File]::WriteAllText(${literal(heartbeat)}, [string]$beat); Start-Sleep -Seconds 1}`,
    `[System.IO.File]::WriteAllText(${literal(done)}, 'done')`, 'exit 0'].join(separator);
}

function assertHeartbeatSurvived(result: {beats: string[]; finished: boolean; hostStoppedEarly: boolean; hostExited: boolean}) {
  const detail = JSON.stringify(result);
  assert.equal(result.hostStoppedEarly, false, detail);
  assert.equal(result.finished, true, detail);
  assert.equal(result.beats.at(-1), '10', detail);
  assert.ok(result.beats.length >= 6, detail);
  const numbers = result.beats.map(Number);
  assert.ok(numbers.every((value, index) => index === 0 || value > numbers[index - 1]!), detail);
  assert.equal(result.hostExited, true, detail);
}

test('the registered WSL host action starts PowerShell under the real headless console host', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t); await enableRelayAutostart(f.options);
  const action = registeredTaskAction(f.scripts);
  // The real action runs wsl.exe; a harmless command that writes a marker takes its place.
  const marker = join(await realpath(await mkdtemp(join(tmpdir(), 'dharma-wsl-headless-'))), 'started.txt');
  t.after(() => rm(join(marker, '..'), {recursive: true, force: true}));
  const command = `[System.IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'started'); exit 0`;
  const argumentsLine = action.arguments.replace(/[A-Za-z0-9+/=]+$/, Buffer.from(command, 'utf16le').toString('base64'));
  assert.notEqual(argumentsLine, action.arguments);
  const result = await runTaskAction(action.execute, argumentsLine, tmpdir(), marker);
  assert.equal(result.content, 'started', JSON.stringify(result));
  assert.equal(result.code, 0, JSON.stringify(result));
});

test('the registered WSL host action keeps a long-running PowerShell client alive with no standard handles', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t); await enableRelayAutostart(f.options);
  const action = registeredTaskAction(f.scripts);
  // The real action blocks in wsl.exe for the whole session; a command that keeps running and writes a heartbeat takes its place.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dharma-wsl-headless-handles-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const heartbeat = join(directory, 'heartbeat.txt');
  const done = join(directory, 'done.txt');
  const command = heartbeatScript(heartbeat, done, '; ');
  const argumentsLine = action.arguments.replace(/[A-Za-z0-9+/=]+$/, Buffer.from(command, 'utf16le').toString('base64'));
  assert.notEqual(argumentsLine, action.arguments);
  assertHeartbeatSurvived(await runTaskActionWithoutHandles(action.execute, argumentsLine, directory, heartbeat, done));
});

test('optional WSL task lookup distinguishes exact absence from a failed scheduler read', async () => {
  const source = await readFile(new URL('../src/wslRelayHost.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('wslRelayHost.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'lookup');
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  const compiled = ts.transpileModule(declaration.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}}).outputText;
  const lookup = compileFunction(compiled + '\nreturn lookup;', ['literal'])((s: string) => `'${s.replaceAll("'", "''")}'`);
  const query = lookup({taskName: 'SyntheticFixture'});
  assert.doesNotMatch(query, /SilentlyContinue/);
  assert.match(query, /-ErrorAction Stop/);
  assert.match(query, /CmdletizationQuery_NotFound,Get-ScheduledTask/);
  assert.match(query, /ObjectNotFound/);
  if (process.platform === 'win32') {
    for (const id of ['CmdletizationQuery_NotFound,Get-ScheduledTask', 'AccessDenied', 'SchedulerUnavailable']) {
      const script = `function Get-ScheduledTask { throw [System.Management.Automation.ErrorRecord]::new(`
        + `[Exception]::new('synthetic'), '${id}', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null) }; `
        + `try { ${query}; if($null -eq $task){[Console]::Out.Write('absent')} } catch {[Console]::Out.Write('failed')} `;
      const stdout = runPowerShellFixture(script);
      assert.equal(stdout, id.startsWith('CmdletizationQuery_NotFound,') ? 'absent' : 'failed');
    }
  }
});

test('WSL startup registers an exact user-logon host action instead of relying on systemd lifetime', async t => {
  const {options, scripts} = await fixture(t);
  await enableRelayAutostart(options);
  assert(scripts.some(script => script.includes('dharma-wsl-host:register')),
    'an enabled Linux service alone cannot keep the WSL distro alive');
  const receipt = await readFile(join(options.home, 'relay', 'wsl-host.json'), 'utf8');
  assert.doesNotMatch(receipt, /password|token|grant|credential/i);
  const action = scripts.find(script => script.includes('dharma-wsl-host:register'))!;
  const nativeAction = registeredTaskAction(scripts);
  assert.match(Buffer.from(nativeAction.arguments.split(' ').at(-1)!, 'base64').toString('utf16le'),
    /start --wait dharma-agent-fabric\.service/);
  assert.match(action, /-LogonType Interactive -RunLevel Limited/);
  assert.match(action, /New-ScheduledTaskTrigger -AtLogOn -User \$current\.Name/);
  assert.match(action, /New-ScheduledTaskPrincipal -UserId \$current\.Name/);
  assert.match(action, /Export-ScheduledTask -TaskPath/);
  assert.match(action, /\$principals\[0\]\.UserId -cne \$current\.User\.Value/);
  assert.doesNotMatch(action, /-Force|ExecutionPolicy|wsl.*--shutdown|sleep infinity/);
  const status = await relayAutostartStatus(options);
  assert.equal(status.state, 'enabled');
  assert.equal(Reflect.get(status, 'restartCoverage'), 'wsl-host-logon');
  assert.equal(Reflect.get(status, 'hostLifecycle'), 'registered');
  await startRelayAutostart(options);
  assert.equal(Reflect.get(await relayAutostartStatus(options), 'hostLifecycle'), 'running');
  const registrationCalls = scripts.filter(script => script.includes('dharma-wsl-host:register')).length;
  await enableRelayAutostart(options);
  assert.equal(scripts.filter(script => script.includes('dharma-wsl-host:register')).length, registrationCalls);
  await disableRelayAutostart(options);
  assert(scripts.some(script => script.includes('dharma-wsl-host:disable')));
  await assert.rejects(readFile(join(options.home, 'relay', 'wsl-host.json')), {code: 'ENOENT'});
});

test('the actual WSL guard validates the persisted SID rather than a normalized account alias', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);await enableRelayAutostart(f.options);
  const preamble=f.scripts.find(s=>s.includes('dharma-wsl-host:status'))!;
  const start=preamble.indexOf('function '),end=preamble.indexOf('if ($null -eq $task)');
  assert.ok(start>0&&end>start);
  const guard=preamble.slice(start,end);
  const task={Description:'synthetic',Actions:[{Execute:'C:\\Windows\\System32\\wsl.exe',Arguments:'synthetic'}],
    Principal:{UserId:'',LogonType:'Interactive',RunLevel:'Limited'},
    Triggers:[{CimClass:{CimClassName:'MSFT_TaskLogonTrigger'},Enabled:true,UserId:''}],
    Settings:{MultipleInstances:'IgnoreNew',ExecutionTimeLimit:'PT0S',RestartCount:0,DisallowStartIfOnBatteries:false,StopIfGoingOnBatteries:false}};
  const receipt=JSON.parse(await readFile(join(f.options.home,'relay','wsl-host.json'),'utf8'));
  const action=registeredTaskAction(f.scripts);
  task.Description=receipt.description;task.Actions[0]!.Execute=action.execute;task.Actions[0]!.Arguments=action.arguments;
  const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const legacyArguments=action.arguments.slice(`--headless ${powershell} `.length);
  // The earlier action ran PowerShell itself. It is still owned and is reported as legacy.
  const cases:{actions:{Execute:string;Arguments:string};foreign?:boolean;result:string}[]=[
    {actions:{Execute:action.execute,Arguments:action.arguments},result:'owned'},
    {actions:{Execute:action.execute,Arguments:action.arguments},foreign:true,result:'refused'},
    {actions:{Execute:receipt.executable,Arguments:receipt.arguments},result:'refused'},
    {actions:{Execute:powershell,Arguments:legacyArguments},result:'owned-legacy'},
    {actions:{Execute:action.execute,Arguments:legacyArguments},result:'refused'},
    {actions:{Execute:powershell,Arguments:action.arguments},result:'refused'},
    {actions:{Execute:'conhost.exe',Arguments:action.arguments},result:'refused'},
    {actions:{Execute:action.execute,Arguments:`--headless powershell.exe ${legacyArguments}`},result:'refused'},
  ];
  for(const {actions,foreign=false,result} of cases){
    const rejected=result==='refused';
    const taskFixture=structuredClone(task);
    taskFixture.Actions[0]!.Execute=actions.Execute;taskFixture.Actions[0]!.Arguments=actions.Arguments;
    const script=`$ErrorActionPreference='Stop';$current=[System.Security.Principal.WindowsIdentity]::GetCurrent(); `
      + `$fixturePrincipalSid=${foreign?"'S-1-5-18'":'$current.User.Value'}; `
      + `function Export-ScheduledTask { '<Task><Principals><Principal><UserId>'+$fixturePrincipalSid+'</UserId></Principal></Principals></Task>' }; `
      + `$task=ConvertFrom-Json ([Console]::In.ReadToEnd());$task.Principal.UserId=($current.Name -split '\\\\')[-1]; `
      + `$task.Triggers[0].UserId=$current.Name; ${guard}; `
      + `try{Assert-OwnedTask $task;[Console]::Out.Write('owned');if(Test-LegacyAction $task){[Console]::Out.Write('-legacy')}}`
      + `catch{[Console]::Out.Write('refused');if(!${rejected?'$true':'$false'}){[Console]::Error.Write($_.Exception.Message)}}`;
    const stdout=runPowerShellFixture(script,JSON.stringify(taskFixture));
    assert.equal(stdout,result,JSON.stringify(actions));
  }
});

test('a foreign WSL host task is refused before startup registration writes', async t => {
  const f = await fixture(t);
  f.foreignTask();
  await assert.rejects(assertRelayStartupOwnership(f.options), /autostart_conflict/);
  await assert.rejects(enableRelayAutostart(f.options), /autostart_conflict/);
  assert(!f.scripts.some(script => script.includes('dharma-wsl-host:register')));
  await assert.rejects(readFile(join(f.options.home, 'relay', 'autostart.json')), {code: 'ENOENT'});
});

test('a lost registration response preserves ownership and readback reconciles without replacement', async t => {
  const f = await fixture(t);
  f.loseResponse();
  await assert.rejects(enableRelayAutostart(f.options), /wsl_host_startup_unavailable/);
  assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
  const before = f.scripts.filter(script => script.includes('dharma-wsl-host:register')).length;
  await enableRelayAutostart(f.options);
  assert.equal(f.scripts.filter(script => script.includes('dharma-wsl-host:register')).length, before);
});

test('changed WSL recipient and injected host fields cannot be adopted, started or disabled', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  const path = join(f.options.home, 'relay', 'wsl-host.json');
  const original = await readFile(path, 'utf8');
  const record = JSON.parse(original);
  for (const delta of [{windowsSid: 'S-1-5-21-123-456-789-9001'}, {arguments: 'arbitrary.exe'},
    {distribution: 'foreign'}, {extra: 'CANARY_PRIVATE_MATERIAL'}]) {
    await writeFile(path, JSON.stringify({...record, ...delta}));
    f.scripts.length = 0;
    assert.equal((await relayAutostartStatus(f.options)).state, 'unavailable');
    await assert.rejects(startRelayAutostart(f.options), /autostart_conflict|unavailable/);
    await assert.rejects(disableRelayAutostart(f.options), /autostart_conflict|unavailable/);
    assert(!f.scripts.some(script => /dharma-wsl-host:(register|start|disable)/.test(script)));
  }
});

test('unavailable WSL interop and malformed distro metadata fail before startup writes', async t => {
  const f = await fixture(t);
  const badContexts = [{distribution: 'Ubuntu"; cmd', linuxUser: 'maatru'},
    {distribution: 'Ubuntu\n', linuxUser: 'maatru'}, {distribution: 'Ubuntu', linuxUser: 'maatru;cmd'}];
  for (const current of badContexts) {
    await assert.rejects(enableRelayAutostart({...f.options, wslHost: {...f.options.wslHost,
      context: async () => current}}), /wsl_host_startup_unavailable/);
  }
  await assert.rejects(enableRelayAutostart({...f.options, wslHost: {...f.options.wslHost,
    run: async () => {throw new Error('interop unavailable');}}}), /wsl_host_startup_unavailable/);
  await assert.rejects(readFile(join(f.options.home, 'relay', 'autostart.json')), {code: 'ENOENT'});
  assert.deepEqual(f.scripts, []);
});

test('WSL cannot report complete startup coverage after its host receipt is lost', async t => {
  const {options} = await fixture(t);
  await enableRelayAutostart(options);
  await rm(join(options.home, 'relay', 'wsl-host.json'), {force: true});
  const status = await relayAutostartStatus(options);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, 'wsl_host_startup_unavailable');
});

test('bare Linux startup does not query or register any Windows host task', async t => {
  const {options, scripts} = await fixture(t);
  const bare = {...options, wslHost: {...options.wslHost, context: async () => null}};
  await enableRelayAutostart(bare);
  assert.equal((await relayAutostartStatus(bare)).state, 'enabled');
  assert.deepEqual(scripts, []);
});

test('injected OS controls also contain Windows interop instead of escaping through a real runner', async t => {
  const f = await fixture(t);
  const seen: string[] = [];
  const options = {...f.options, wslHost: {context: f.options.wslHost.context},
    run: async (file: string, args: string[]) => {
      seen.push(file);
      if (file === 'systemctl') return {stdout: 'enabled\n'};
      assert.equal(file, '/init');
      return f.options.wslHost.run(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'));
    }};
  await enableRelayAutostart(options);
  assert(seen.includes('/init'));
});

test('withdrawal during WSL registration preserves the receipt but admits no later OS action', async t => {
  const f = await fixture(t), controller = new AbortController(), now = Date.now();
  const prepared = prepareCodexBootstrapHost({workspace: f.options.userHome, signal: controller.signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: '11111111-1111-4111-8111-111111111111',
      setupReference: '22222222-2222-4222-8222-222222222222', organizationId: 'org_demo',
      recipientMembershipId: '33333333-3333-4333-8333-333333333333', origin: 'https://hq.example',
      repositoryFingerprint: `sha256:${'a'.repeat(64)}`, policyRevision: 'policy-v1',
      scopeDigest: `sha256:${'a'.repeat(64)}`, contractDigest: `sha256:${'b'.repeat(64)}`,
      hostContextId: '44444444-4444-4444-8444-444444444444', issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString()}});
  t.after(() => prepared.scope.close());
  const options = {...f.options, wslHost: {...f.options.wslHost, run: async (script: string) => {
    const result = await f.options.wslHost.run(script);
    if (script.includes('dharma-wsl-host:register')) controller.abort();
    return result;
  }}};
  await assert.rejects(runCodexBootstrapHostScope(prepared.scope, () => enableRelayAutostart(options)), /scope_unavailable/);
  assert(f.scripts.at(-1)?.includes('dharma-wsl-host:register'));
  assert.equal(JSON.parse(await readFile(join(options.home, 'relay', 'wsl-host.json'), 'utf8')).schema, 'dharma.wsl-relay-host/v1');
});

test('WSL systemd startup resolves missing session metadata only from its owned binding', () => {
  const installed = {schema: 'dharma.wsl-relay-host/v1', distribution: 'Ubuntu', linuxUser: 'maatru'};
  assert.deepEqual(resolveWslRelayContext(undefined, 'maatru', installed), {distribution: 'Ubuntu', linuxUser: 'maatru'});
  for (const value of [null, {}, {...installed, linuxUser: 'other'}, {...installed, distribution: 'Ubuntu\n'}]) {
    assert.throws(() => resolveWslRelayContext(undefined, 'maatru', value), /wsl_host_startup_unavailable/);
  }
});

test('WSL host receipt schema excludes secrets and unbounded command authority', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  const record = JSON.parse(await readFile(join(f.options.home, 'relay', 'wsl-host.json'), 'utf8'));
  const schema = 'https://schemas.dharma-ai.io/wsl-relay-host/v1';
  const validate = (value: unknown) => validateContract(join(import.meta.dirname, 'schemas'), schema, value);
  assert.equal((await validate(record)).ok, true);
  for (const delta of [{token: 'CANARY_NEVER_ALLOWED'}, {password: 'CANARY_NEVER_ALLOWED'},
    {arguments: 'arbitrary.exe'}, {windowsSid: '*'}, {linuxUser: 'user;cmd'}]) {
    assert.equal((await validate({...record, ...delta})).ok, false);
  }
});

test('generated WSL host commands pass the actual Windows PowerShell parser without execution', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  await startRelayAutostart(f.options);
  await disableRelayAutostart(f.options);
  const script = `$items=ConvertFrom-Json ([Console]::In.ReadToEnd()); `
    + `foreach($item in $items) {$tokens=$null;$errors=$null; `
    + `[System.Management.Automation.Language.Parser]::ParseInput($item,[ref]$tokens,[ref]$errors)|Out-Null; `
    + `if ($errors.Count -gt 0) {[Console]::Error.Write('generated_wsl_host_parse_error');exit 1}}; `
    + `[Console]::Out.Write($items.Count)`;
  const stdout = runPowerShellFixture(script, JSON.stringify(f.scripts));
  assert.equal(Number(stdout), f.scripts.length);
});
