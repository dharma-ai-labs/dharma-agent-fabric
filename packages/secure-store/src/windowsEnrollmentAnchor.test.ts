import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {secureStoreInternals, type EnrollmentAnchorWrite} from './index.js';
import {windowsEnrollmentAnchorWrite} from './windowsEnrollmentAnchor.js';

const account = () => 'device-enrollment-' + randomBytes(16).toString('hex');
const request = (): EnrollmentAnchorWrite => ({account: account(), legacyAccount: account(),
  expectedCurrent: null, expectedLegacy: null, secret: 'synthetic-anchor'});

test('Windows conditional writes validate accounts, require exact receipts and never retry uncertain mutations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-cas-bridge-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const calls = join(root, 'calls');
  const bridge = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'x');
    let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{
      const input=JSON.parse(text);if(input.secret==='fail') {process.stderr.write('ECONNRESET synthetic-private-detail');process.exitCode=1;}
      else process.stdout.write(input.secret);
    });`;
  const store = secureStoreInternals.windowsStore(undefined, {command: process.execPath,
    prefixArgs: ['-e', bridge, '--'], timeoutMs: 2500, retryAttempts: 3});
  await assert.rejects(store.compareAndPutEnrollmentAnchor!({...request(), account: 'other-account'}), /Invalid enrollment/);
  await assert.rejects(store.put(account(), 'synthetic'), /conditional write/);
  assert.equal(await store.compareAndPutEnrollmentAnchor!({...request(), secret: 'written'}), true);
  assert.equal(await store.compareAndPutEnrollmentAnchor!({...request(), secret: 'conflict'}), false);
  await assert.rejects(store.compareAndPutEnrollmentAnchor!({...request(), secret: 'fail'}),
    {message: 'Windows enrollment anchor operation unavailable or unconfirmed.'});
  await assert.rejects(store.compareAndPutEnrollmentAnchor!({...request(), secret: 'unknown'}),
    {message: 'Windows enrollment anchor operation unavailable or unconfirmed.'});
  assert.equal(await readFile(calls, 'utf8'), 'xxxx');
});

test('conditional backend writes invalidate stale process cache on success, conflict and failure', async () => {
  let current: string | null = 'old', mode = 'written';
  const raw = {backend: 'windows-credential-manager' as const, get: async () => current,
    put: async (_account: string, value: string) => {current = value;}, delete: async () => {current = null;},
    compareAndPutEnrollmentAnchor: async (input: EnrollmentAnchorWrite) => {
      current = mode === 'written' ? input.secret : 'other-writer';
      if (mode === 'failed') throw Error('synthetic failure');
      return mode === 'written';
    }};
  const store = secureStoreInternals.processCachedStore(raw), input = request();
  for (mode of ['written', 'conflict', 'failed']) {
    current = 'old'; assert.equal(await store.getFresh!(input.account), 'old');
    if (mode === 'failed') await assert.rejects(store.compareAndPutEnrollmentAnchor!(input), /synthetic failure/);
    else assert.equal(await store.compareAndPutEnrollmentAnchor!(input), mode === 'written');
    assert.equal(await store.get(input.account), current);
  }
});

function syntheticVault(root: string) {
  // Replace the vault and classify only fixture failures; production SID, mutex,
  // ACL, comparisons, deadline and failure exit remain unchanged.
  const preamble = `
class SyntheticCredential {
  [string]$Resource; [string]$UserName; [string]$Password
  SyntheticCredential([string]$resource,[string]$user,[string]$password) {
    $this.Resource=$resource; $this.UserName=$user; $this.Password=$password
  }
  [void] RetrievePassword() {}
}
class SyntheticVault {
  [string]$Root
  SyntheticVault([string]$root) {$this.Root=$root}
  [SyntheticCredential] Retrieve([string]$resource,[string]$account) {
    $path=[IO.Path]::Combine($this.Root,$account)
    if ($account -eq 'device-enrollment-ffffffffffffffffffffffffffffffff') {
      throw [Runtime.InteropServices.COMException]::new("Synthetic denied",-2147024891)
    }
    if (![IO.File]::Exists($path)) {throw [Runtime.InteropServices.COMException]::new("Absent",-2147023728)}
    return [SyntheticCredential]::new($resource,$account,[IO.File]::ReadAllText($path))
  }
  [void] Add([SyntheticCredential]$credential) {
    Start-Sleep -Milliseconds 400
    if ($credential.Password -eq 'synthetic-add-failure') {throw "Synthetic failure"}
    [IO.File]::WriteAllText([IO.Path]::Combine($this.Root,$credential.UserName),$credential.Password)
  }
}
$vault=[SyntheticVault]::new('${root.replaceAll("'", "''")}')
`;
  const script=windowsEnrollmentAnchorWrite.replace(/\r\n/g,'\n').replace(
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime\n  $vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()', preamble)
    .replace('[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(',
      '[SyntheticCredential]::new(');
  assert.doesNotMatch(script,/Windows\.Security\.Credentials/);
  return script.replace('[Console]::Error.Write("Enrollment anchor operation failed.")',`
  $category="UNCLASSIFIED"
  if ($_.Exception.GetBaseException().Message -ceq "Anchor busy") {$category="LOCK_BUSY"}
  elseif ($_.Exception.GetBaseException().Message -ceq "Unsafe anchor mutex") {$category="UNSAFE_MUTEX"}
  elseif ($_.Exception.GetBaseException() -is [Threading.AbandonedMutexException]) {$category="ABANDONED_MUTEX"}
  [Console]::Error.Write("ANCHOR_FIXTURE_"+$category)`);
}

test('synthetic Windows anchor diagnostics are newline-stable, fixed and fail-closed', () => {
  const script=syntheticVault('C:/synthetic-anchor-fixture');
  assert.doesNotMatch(script,/Windows\.Security\.Credentials/);
  assert.equal(script.includes('\r\n'),false);
  assert.match(script,/ANCHOR_FIXTURE_/);
  assert.match(script,/\$mutex\.WaitOne\(2000\)/);
  assert.match(script,/if \(!\$owned\) \{throw "Anchor busy"\}/);
  assert.match(script,/exit 1/);
});

function assertConcurrentAnchorOutcomes(outcomes: ReadonlyArray<{code: number | null; stdout: string; stderr: string}>) {
  assert.equal(outcomes.length, 2);
  const writers = outcomes.map((value, index) => ({value, index}))
    .filter(({value}) => value.code === 0 && value.stdout === 'written');
  assert.equal(writers.length, 1, 'exactly one contender must commit');
  const writer = writers[0]!;
  assert.equal(writer.value.stderr, '');
  const other = outcomes[1 - writer.index]!;
  // A contender can exhaust the unchanged mutex deadline, but no arbitrary
  // helper failure or second write may stand in for a bounded refusal.
  assert.ok(other.code === 0 && other.stdout === 'conflict' && other.stderr === ''
    || other.code === 1 && other.stdout === '' && other.stderr === 'ANCHOR_FIXTURE_LOCK_BUSY',
  JSON.stringify({code: other.code, stdout: other.stdout, stderr: other.stderr}));
  return writer.index;
}

test('concurrent Windows fixture outcomes require one writer and permit only explicit conflict or bounded busy', () => {
  const written = {code: 0, stdout: 'written', stderr: ''};
  const conflict = {code: 0, stdout: 'conflict', stderr: ''};
  const busy = {code: 1, stdout: '', stderr: 'ANCHOR_FIXTURE_LOCK_BUSY'};
  assert.equal(assertConcurrentAnchorOutcomes([written, conflict]), 0);
  assert.equal(assertConcurrentAnchorOutcomes([busy, written]), 1);
  for (const outcomes of [
    [written, written], [busy, busy], [conflict, conflict],
    [written, {code: 1, stdout: '', stderr: 'ANCHOR_FIXTURE_UNCLASSIFIED'}],
    [written, {code: 1, stdout: 'conflict', stderr: 'ANCHOR_FIXTURE_LOCK_BUSY'}],
    [{...written, stderr: 'unexpected'}, conflict],
  ]) assert.throws(() => assertConcurrentAnchorOutcomes(outcomes), {code: 'ERR_ASSERTION'});
});

test('independent Windows helpers preserve bounded exclusion across both anchor slots at the SID/kernel boundary', {skip: process.platform !== 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-cas-kernel-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const input = request(), script = syntheticVault(root);
  assert.doesNotMatch(script, /Windows.Security.Credentials/);
  const invoke = (value: EnrollmentAnchorWrite) => secureStoreInternals.run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '& { ' + script + ' }'], JSON.stringify(value), 15000);
  const outcomes = await Promise.all([invoke({...input, secret: 'first'}), invoke({...input, secret: 'second'})]);
  const writer = assertConcurrentAnchorOutcomes(outcomes);
  const preserved = await readFile(join(root, input.account), 'utf8');
  assert.equal(preserved, ['first', 'second'][writer]);
  assert.equal((await invoke({...input, expectedCurrent: preserved, secret: 'synthetic-add-failure'})).code, 1);
  assert.equal(await readFile(join(root, input.account), 'utf8'), preserved);
  await writeFile(join(root, input.legacyAccount), 'legacy-competing');
  assert.equal((await invoke({...input, expectedCurrent: preserved, secret: 'replacement'})).stdout, 'conflict');
  assert.equal(await readFile(join(root, input.account), 'utf8'), preserved);
  assert.equal(await readFile(join(root, input.legacyAccount), 'utf8'), 'legacy-competing');
  const denied = {...request(), account: 'device-enrollment-ffffffffffffffffffffffffffffffff'};
  assert.equal((await invoke(denied)).code, 1, 'access failure must never establish absence');
});

test('an older in-flight cached read cannot repopulate an anchor after a conditional write', async () => {
  let finish!: (value: string | null) => void, reads = 0, current = 'old';
  const pending = new Promise<string | null>(accept => {finish = accept;});
  const store = secureStoreInternals.processCachedStore({backend: 'windows-credential-manager',
    get: async () => ++reads === 1 ? pending : current,
    put: async () => {}, delete: async () => {},
    compareAndPutEnrollmentAnchor: async input => {current = input.secret; return true;}});
  const input = request(), before = store.get(input.account);
  await store.compareAndPutEnrollmentAnchor!(input);
  finish('old'); assert.equal(await before, 'old');
  assert.equal(await store.get(input.account), 'synthetic-anchor');
});

test('a Windows read access error is never reported as an absent anchor', {skip: process.platform !== 'win32'}, async () => {
  const {readFile} = await import('node:fs/promises');
  const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const readerSource = await readFile(new URL('../src/windowsFreshRead.ts', import.meta.url), 'utf8');
  // Execute the exact production catch bodies against a synthetic WinRT HRESULT.
  const single = indexSource.match(/const windowsRead = .*?catch \{([^\n]*)\}\x60;/)![1];
  const broker = readerSource.match(/\} catch \{([^]*?)\n  \[Console\]::Out.WriteLine/)![1];
  for (const body of [single, broker]) {
    const result = await secureStoreInternals.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '& { $request=@{id=1};try {throw [Runtime.InteropServices.COMException]::new("synthetic denied",-2147024891)} catch {' +
      body + '};if ($null -ne $response) {[Console]::Out.Write(($response|ConvertTo-Json -Compress))} }'], undefined, 10000);
    assert.ok(result.code !== 3 && !result.stdout.includes('"status":3'),
      'access errors must fail closed, never produce the absence sentinel');
  }
});

test('Windows helpers reject a preexisting mutex with another principal allowed', {skip: process.platform !== 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-cas-mutex-acl-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const input = request(), ready = join(root, 'ready');
  const holderScript = `
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=[Security.AccessControl.MutexSecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.MutexAccessRule]::new($sid,[Security.AccessControl.MutexRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
    $acl.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.MutexRights]::Synchronize,[Security.AccessControl.AccessControlType]::Allow))
    $created=$false;$mutex=[Threading.Mutex]::new($false,
      ('Global\\DharmaFabricEnrollment-'+$sid.Value+'-${input.legacyAccount}'),[ref]$created,$acl)
    try {[IO.File]::WriteAllText('${ready.replaceAll("'", "''")}','ready');Start-Sleep -Seconds 3} finally {$mutex.Dispose()}
  `;
  const holder = secureStoreInternals.run('powershell.exe',
    ['-NoProfile','-NonInteractive','-Command','& { '+holderScript+' }'], undefined, 10000);
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {await readFile(ready);break;} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error;
        await new Promise(accept => setTimeout(accept,25));
      }
    }
    const outcome = await secureStoreInternals.run('powershell.exe',
      ['-NoProfile','-NonInteractive','-Command','& { '+syntheticVault(root)+' }'], JSON.stringify(input),10000);
    assert.equal(outcome.code,1);
    await assert.rejects(readFile(join(root,input.account)),{code:'ENOENT'});
  } finally {assert.equal((await holder).code,0);}
});
