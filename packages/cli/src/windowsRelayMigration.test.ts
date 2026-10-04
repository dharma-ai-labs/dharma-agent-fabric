import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';
import { enableRelayAutostart, relayAutostartStatus, inspectOwnedRelayAutostart,
  startRelayAutostart, stopRelayAutostart, disableRelayAutostart, recoverWindowsRelayAutostart,
  windowsRelayTaskArguments } from './relayAutostart.js';

async function fixture(policy: string | null = "C:\\A's Repo\\.dharma\\approved-policy.json") {
  const root = await mkdtemp(join(tmpdir(), 'dharma-windows-hidden-'));
  const commands: string[] = [];
  let task: { arguments: string; enabled: boolean; running: boolean } | null = null;
  let failRegistration = false;
  let failQueries = 0;
  let afterRegister: (() => void) | undefined;
  const options = { platform: 'win32' as const, home: join(root, 'private home'), userHome: root,
    workspace: "C:\\A's Repo", launcher: "C:\\A's Repo\\.dharma\\bin\\dharma.cmd", policy, version: '0.2.140',
    run: async (_file: string, args: string[]) => {
      const command = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      commands.push(command);
      if (command.includes('Register-ScheduledTask')) {
        if (failRegistration) { failRegistration = false; throw new Error('synthetic scheduler failure'); }
        const argumentsValue = command.match(/-Argument '((?:[^']|'')*)'/)?.[1]?.replaceAll("''", "'");
        assert.ok(argumentsValue);
        task = { arguments: argumentsValue, enabled: true, running: false };
        afterRegister?.();
      }
      if (command.includes('Unregister-ScheduledTask')) task = null;
      if (command.includes('Disable-ScheduledTask') && task) task.enabled = false;
      if (command.includes("'exists'")) return { stdout: task ? 'exists\n' : 'absent\n' };
      if (command.includes('ConvertTo-Json')) {
        if (failQueries > 0) { failQueries--; throw new Error('synthetic lost readback'); }
        return { stdout: JSON.stringify(task ? {
        state: task.enabled ? 'enabled' : 'disabled',
        visibility: task.arguments.includes('-WindowStyle Hidden') ? 'hidden' : 'legacy',
        running: task.running,
      } : { state: 'absent', visibility: null, running: false }) };
      }
      return { stdout: 'enabled\n' };
    } };
  const receipt = join(options.home, 'relay', 'autostart.json');
  const script = join(options.home, 'relay', 'autostart.ps1');
  return { options, commands, receipt, script, journal: join(options.home, 'relay', 'windows-startup-transaction.json'),
    getTask: () => task, setTask: (value: typeof task) => { task = value; },
    failQueries: (count: number) => { failQueries = count; }, afterRegister: (fn: (() => void) | undefined) => { afterRegister = fn; },
    failRegistration: () => { failRegistration = true; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('fresh Windows registration uses one hidden action and keeps enrollment scope', async () => {
  const f = await fixture();
  try {
    const status = await enableRelayAutostart(f.options);
    assert.match(f.getTask()!.arguments, /^-NoProfile -NonInteractive -WindowStyle Hidden -File "/);
    assert.equal((status as { windowsVisibility?: string }).windowsVisibility, 'hidden');
    const command = f.commands.find(value => value.includes('Register-ScheduledTask'))!;
    assert.match(command, /-LogonType Interactive -RunLevel Limited/);
    assert.match(command, /-MultipleInstances IgnoreNew/);
    assert.match(command, /-RestartCount 10/);
    assert.doesNotMatch(command, /-Password|--grant|ExecutionPolicy|SYSTEM/);
    const registered = JSON.parse(await readFile(f.receipt, 'utf8'));
    assert.equal(registered.workspace, f.options.workspace);
    assert.equal(registered.policy, f.options.policy);
  } finally { await f.cleanup(); }
});

test('legacy migration and repeated registration preserve task identity in standard and demo modes', async () => {
  for (const policy of ["C:\\A's Repo\\policy.json", null]) {
    const f = await fixture(policy);
    try {
      await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
      const before = await readFile(f.receipt, 'utf8');
      assert.deepEqual(await relayAutostartStatus(f.options), { state: 'enabled', backend: 'windows-task',
        version: f.options.version, windowsVisibility: 'legacy', migrationRequired: true });
      f.commands.length = 0;
      await enableRelayAutostart(f.options);
      assert.equal(await readFile(f.receipt, 'utf8'), before);
      assert.equal(f.getTask()!.arguments, windowsRelayTaskArguments(f.options.home));
      assert.ok(f.commands.findIndex(value => value.includes('Disable-ScheduledTask'))
        < f.commands.findIndex(value => value.includes('Register-ScheduledTask')));
      f.commands.length = 0;
      await enableRelayAutostart(f.options);
      assert.ok(!f.commands.some(value => /Register-ScheduledTask|Disable-ScheduledTask/.test(value)));
      assert.equal(await readFile(f.receipt, 'utf8'), before);
    } finally { await f.cleanup(); }
  }
});

test('failed legacy migration restores its original disabled state and exact arguments', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
    f.getTask()!.enabled = false;
    const before = await readFile(f.receipt, 'utf8');
    f.failRegistration();
    await assert.rejects(enableRelayAutostart(f.options), /registration_failed/);
    assert.equal(f.getTask()!.arguments, windowsRelayTaskArguments(f.options.home, 'legacy'));
    assert.equal(f.getTask()!.enabled, false);
    assert.equal(await readFile(f.receipt, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('lost readback retains an explicit recovery transaction and never silently adopts it', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
    const before = await readFile(f.receipt, 'utf8');
    f.afterRegister(() => { f.failQueries(2); });
    await assert.rejects(enableRelayAutostart(f.options), /recovery_required/);
    f.afterRegister(undefined);
    assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).state, 'prepared');
    assert.equal((await relayAutostartStatus(f.options)).reason, 'autostart_recovery_required');
    await assert.rejects(enableRelayAutostart(f.options), /recovery_required/);
    await assert.rejects(startRelayAutostart(f.options), /recovery_required/);
    await assert.rejects(disableRelayAutostart(f.options), /recovery_required/);
    const snapshot = await readFile(f.journal, 'utf8');
    assert.equal((await recoverWindowsRelayAutostart({ ...f.options, dryRun: true })).state, 'planned');
    assert.equal(await readFile(f.journal, 'utf8'), snapshot);
    await assert.rejects(recoverWindowsRelayAutostart({ ...f.options, workspace: 'C:\\foreign' }), /workspace_conflict/);
    assert.equal((await recoverWindowsRelayAutostart(f.options)).state, 'rolled_back');
    assert.equal(await readFile(f.receipt, 'utf8'), before);
    assert.equal(f.getTask()!.arguments, windowsRelayTaskArguments(f.options.home, 'legacy'));
  } finally { await f.cleanup(); }
});

test('running owned task is refused before transaction or startup writes', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
    const before = await readFile(f.journal, 'utf8');
    f.getTask()!.running = true;
    await assert.rejects(enableRelayAutostart(f.options), /runtime_busy/);
    assert.equal(await readFile(f.journal, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('malformed readback and scheduler failures do not become missing-task permission', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart(f.options);
    const before = await readFile(f.receipt, 'utf8');
    const commands = f.commands.length;
    f.failQueries(1);
    await assert.rejects(enableRelayAutostart({ ...f.options, version: '0.2.141' }));
    assert.equal(await readFile(f.receipt, 'utf8'), before);
    assert.ok(!f.commands.slice(commands).some(command => command.includes('Register-ScheduledTask')));
    const result = await relayAutostartStatus({ ...f.options, run: async () => ({ stdout: JSON.stringify({
      state: 'enabled', visibility: 'hidden', running: false, rawStderr: 'excluded' }) }) });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.reason, 'task_scheduler_unavailable');
    assert.ok(!JSON.stringify(result).includes('rawStderr'));
    assert.match(f.commands.find(command => command.includes('Get-ScheduledTask'))!, /ObjectNotFound/);
    assert.doesNotMatch(f.commands.join('\n'), /SilentlyContinue/);
  } finally { await f.cleanup(); }
});

test('fresh registration failure removes only its owned files and leaves no task', async () => {
  const f = await fixture();
  try {
    f.failRegistration();
    await assert.rejects(enableRelayAutostart(f.options), /registration_failed/);
    assert.equal(f.getTask(), null);
    await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
    await assert.rejects(readFile(f.script), { code: 'ENOENT' });
    assert.equal((await relayAutostartStatus(f.options)).state, 'disabled');
  } finally { await f.cleanup(); }
});

test('lost registration acknowledgement restores legacy ownership without touching sibling state', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
    const sibling = join(f.options.home, 'sibling-policy-sentinel.json');
    await writeFile(sibling, '{"fixture":"unchanged"}');
    const before = await readFile(f.receipt, 'utf8');
    f.afterRegister(() => { f.afterRegister(undefined); throw new Error('synthetic lost acknowledgement'); });
    await assert.rejects(enableRelayAutostart(f.options), /registration_failed/);
    assert.equal(await readFile(f.receipt, 'utf8'), before);
    assert.equal(f.getTask()!.arguments, windowsRelayTaskArguments(f.options.home, 'legacy'));
    assert.equal(await readFile(sibling, 'utf8'), '{"fixture":"unchanged"}');
  } finally { await f.cleanup(); }
});

test('actual supervisor and relay child call sites retain quiet Windows launch options', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  for (const name of ['startRelayDaemon', 'relaySupervise']) {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'spawn') calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    assert.equal(calls.length, 1);
    const options = calls[0]!.arguments[2]!;
    assert.ok(ts.isObjectLiteralExpression(options));
    const properties = options.properties.filter(ts.isPropertyAssignment);
    assert.ok(properties.some(property => property.name.getText(source) === 'windowsHide'
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword));
    assert.ok(properties.some(property => property.name.getText(source) === 'stdio'
      && property.initializer.getText(source) === "'ignore'"));
    assert.ok(properties.some(property => property.name.getText(source) === 'cwd'));
  }
});

test('tampered journal or script never qualifies recovery or migration', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart(f.options);
    const before = await readFile(f.journal, 'utf8');
    await writeFile(f.journal, JSON.stringify({ ...JSON.parse(before), unexpected: true }));
    assert.equal((await relayAutostartStatus(f.options)).reason, 'autostart_journal_invalid');
    await assert.rejects(recoverWindowsRelayAutostart(f.options), /transaction_invalid/);
    await writeFile(f.journal, before);
    await writeFile(f.script, 'foreign script');
    await assert.rejects(enableRelayAutostart(f.options), /autostart_conflict/);
    assert.equal(await readFile(f.script, 'utf8'), 'foreign script');
  } finally { await f.cleanup(); }
});

test('actual PowerShell guard accepts only exact owned actions and current limited interactive user',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await fixture();
    try {
      await enableRelayAutostart(f.options);
      const query = f.commands.find(command => command.includes('ConvertTo-Json'))!;
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
      for (const variation of ['hidden', 'legacy', 'wrong-user', 'wrong-executable', 'extra-argument',
        'wrong-workspace', 'highest', 'service-account', 'multiple-actions', 'foreign-task-path']) {
        const args = windowsRelayTaskArguments(f.options.home, variation === 'legacy' ? 'legacy' : 'hidden');
        const setup = `$ErrorActionPreference='Stop'; `
          + `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `
          + `$action=@{Execute=${literal(variation === 'wrong-executable' ? 'cmd.exe' : 'powershell.exe')}; `
          + `Arguments=${literal(args + (variation === 'extra-argument' ? ' -NoExit' : ''))}; `
          + `WorkingDirectory=${literal(variation === 'wrong-workspace' ? 'C:\\foreign' : f.options.workspace)}}; `
          + `$script:fakeTask=@{Actions=@($action${variation === 'multiple-actions' ? ',$action' : ''}); `
          + `TaskPath=${literal(variation === 'foreign-task-path' ? '\\foreign\\' : '\\')}; State='Ready'; `
          + `Principal=@{RunLevel='${variation === 'highest' ? 'Highest' : 'Limited'}'; `
          + `LogonType='${variation === 'service-account' ? 'ServiceAccount' : 'Interactive'}'}}; `
          + `function Get-ScheduledTask { param($TaskName,$ErrorAction) $script:fakeTask }; `
          + `function Export-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) `
          + `'<Task><Principals><Principal><UserId>'+${variation === 'wrong-user' ? "'S-1-5-18'" : '$sid'}`
          + `+'</UserId></Principal></Principals></Task>' }; `;
        const command = setup + query;
        const execute = () => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
        if (variation === 'hidden' || variation === 'legacy') {
          assert.equal(JSON.parse((await execute()).stdout).visibility, variation);
        } else {
          await assert.rejects(execute(), error => String((error as { stderr?: string }).stderr).includes('autostart_conflict'));
        }
      }
    } finally { await f.cleanup(); }
  });

test('every interrupted local write boundary requires explicit recovery before lifecycle mutation', async () => {
  for (const boundary of ['prepared', 'script', 'receipt', 'task', 'restored-script', 'restored-receipt']) {
    const f = await fixture();
    try {
      await enableRelayAutostart({ ...f.options, windowsVisibility: 'legacy' });
      const previousReceipt = await readFile(f.receipt, 'utf8');
      const previousScript = await readFile(f.script, 'utf8');
      await enableRelayAutostart({ ...f.options, version: '0.2.141' });
      const journal = JSON.parse(await readFile(f.journal, 'utf8'));
      journal.state = 'prepared';
      if (['prepared', 'script', 'restored-script', 'restored-receipt'].includes(boundary)) await writeFile(f.receipt, previousReceipt);
      if (['prepared', 'restored-script', 'restored-receipt'].includes(boundary)) await writeFile(f.script, previousScript);
      f.setTask({ arguments: windowsRelayTaskArguments(f.options.home, ['task', 'restored-script', 'restored-receipt'].includes(boundary)
        ? 'hidden' : 'legacy'), enabled: false, running: false });
      await writeFile(f.journal, JSON.stringify(journal));
      assert.equal((await relayAutostartStatus(f.options)).reason, 'autostart_recovery_required');
      await assert.rejects(stopRelayAutostart(f.options), /recovery_required/);
      await assert.rejects(recoverWindowsRelayAutostart({ ...f.options, policy: 'C:\\foreign\\policy' }), /scope_conflict/);
      assert.equal((await recoverWindowsRelayAutostart(f.options)).state, 'rolled_back');
      assert.equal(await readFile(f.receipt, 'utf8'), previousReceipt);
      assert.equal(await readFile(f.script, 'utf8'), previousScript);
      assert.equal(f.getTask()!.arguments, windowsRelayTaskArguments(f.options.home, 'legacy'));
      assert.equal(f.getTask()!.enabled, true);
    } finally { await f.cleanup(); }
  }
});

test('failed Windows update restores the old task, script and receipt together', async () => {
  const f = await fixture();
  try {
    await enableRelayAutostart(f.options);
    const beforeReceipt = await readFile(f.receipt, 'utf8');
    const beforeScript = await readFile(f.script, 'utf8');
    const beforeArguments = f.getTask()!.arguments;
    f.failRegistration();
    await assert.rejects(enableRelayAutostart({ ...f.options, version: '0.2.141',
      launcher: "C:\\Changed Repo\\dharma.cmd" }));
    assert.equal(await readFile(f.receipt, 'utf8'), beforeReceipt);
    assert.equal(await readFile(f.script, 'utf8'), beforeScript);
    assert.equal(f.getTask()!.arguments, beforeArguments);
    assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
  } finally { await f.cleanup(); }
});

test('hidden Windows task lifecycle retains exact guard and limited interactive principal', async () => {
  const f = await fixture(null);
  try {
    await enableRelayAutostart(f.options);
    await inspectOwnedRelayAutostart(f.options);
    await startRelayAutostart(f.options);
    await stopRelayAutostart(f.options);
    await disableRelayAutostart(f.options);
    for (const verb of ['Start-ScheduledTask', 'Stop-ScheduledTask', 'Unregister-ScheduledTask']) {
      const command = f.commands.find(value => value.includes(verb))!;
      assert.match(command, /-WindowStyle Hidden/);
      assert.match(command, /RunLevel/);
      assert.match(command, /LogonType/);
      assert.match(command, /WindowsIdentity/);
      assert.match(command, /WorkingDirectory/);
      assert.match(command, /autostart_conflict/);
    }
  } finally { await f.cleanup(); }
});
