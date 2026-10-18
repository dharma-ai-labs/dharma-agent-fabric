import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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
          if (loseRegistrationResponse) throw new Error('registration response lost');
        }
        if (script.includes('dharma-wsl-host:start')) running = true;
        if (script.includes('dharma-wsl-host:disable')) {exists = false;enabled=false;running = false;}
        if (script.includes('dharma-wsl-host:pause')) enabled=false;
        return {stdout: JSON.stringify({exists, enabled, running})};
      },
    },
  };
  return {options, scripts, foreignTask: () => {exists = true;enabled=true;}, loseResponse: () => {loseRegistrationResponse = true;}};
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

test('WSL task uses the verified PowerShell host for its fixed native wait action', async t => {
  const f = await fixture(t); await enableRelayAutostart(f.options);
  const action = registeredTaskAction(f.scripts);
  assert.equal(action.execute, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(action.arguments, /^-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(action.arguments.split(' ').at(-1)!, 'base64').toString('utf16le');
  assert.equal(script, "$ErrorActionPreference='Stop'; & 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ubuntu' --user 'maatru' --cd / --exec /usr/bin/systemctl --user start --wait dharma-agent-fabric.service; exit $LASTEXITCODE");
  assert.doesNotMatch(script, /ExecutionPolicy|credential|password|token|grant|Start-Process|Invoke-Expression/i);
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
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], {encoding: 'utf8', timeout: 15000, windowsHide: true});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, id.startsWith('CmdletizationQuery_NotFound,') ? 'absent' : 'failed');
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
  for(const {foreign,legacyDirectAction} of [{foreign:false,legacyDirectAction:false},
    {foreign:true,legacyDirectAction:false},{foreign:false,legacyDirectAction:true}]){
    const rejected=foreign||legacyDirectAction;
    const taskFixture=structuredClone(task);
    if(legacyDirectAction){taskFixture.Actions[0]!.Execute=receipt.executable;taskFixture.Actions[0]!.Arguments=receipt.arguments;}
    const script=`$ErrorActionPreference='Stop';$current=[System.Security.Principal.WindowsIdentity]::GetCurrent(); `
      + `$fixturePrincipalSid=${foreign?"'S-1-5-18'":'$current.User.Value'}; `
      + `function Export-ScheduledTask { '<Task><Principals><Principal><UserId>'+$fixturePrincipalSid+'</UserId></Principal></Principals></Task>' }; `
      + `$task=ConvertFrom-Json ([Console]::In.ReadToEnd());$task.Principal.UserId=($current.Name -split '\\\\')[-1]; `
      + `$task.Triggers[0].UserId=$current.Name; ${guard}; `
      + `try{Assert-OwnedTask $task;[Console]::Out.Write('owned')}catch{[Console]::Out.Write('refused');`
      + `if(!${rejected?'$true':'$false'}){[Console]::Error.Write($_.Exception.Message)}}`;
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {input:JSON.stringify(taskFixture),encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,rejected?'refused':'owned',result.stderr);
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
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {input: JSON.stringify(f.scripts), encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16384});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout), f.scripts.length);
});
