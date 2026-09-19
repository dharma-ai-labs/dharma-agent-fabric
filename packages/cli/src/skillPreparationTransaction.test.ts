import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertWindowsSkillPreparationAcl, skillPreparationScopeRoot, withSkillPreparationTransaction } from './skillPreparationTransaction.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

test('Windows preparation ACL policy rejects foreign read/write/owner grants and malformed output', () => {
  const user = 'S-1-5-21-100-200-300-1000';
  const rules = [user, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, rights: 2032127, inheritOnly: false }));
  const acl = { currentUserSid: user, ownerSid: user, daclPresent: true, daclNull: false, allowRules: rules };
  assert.doesNotThrow(() => assertWindowsSkillPreparationAcl(acl));
  assert.doesNotThrow(() => assertWindowsSkillPreparationAcl({ ...acl, allowRules: [...rules, { sid: 'S-1-3-0', rights: 2032127, inheritOnly: true }] }));
  for (const rights of [1, 2, 4, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000, 0x01000000]) {
    assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl,
      allowRules: [...rules, { sid: 'S-1-5-32-545', rights, inheritOnly: false }] }), /private/);
  }
  assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl, ownerSid: 'S-1-5-21-900-900-900-1000' }), /privately owned/);
  assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl, allowRules: [{ sid: user, rights: 'full', inheritOnly: false }] }), /Invalid/);
  assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl, allowRules: [{ sid: user, rights: -1, inheritOnly: false }] }), /Invalid/);
  assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl, allowRules: {} }), /Invalid/);
  for (const flags of [{ daclPresent: false }, { daclNull: true }, { daclPresent: undefined }, { daclNull: 'false' }]) {
    assert.throws(() => assertWindowsSkillPreparationAcl({ ...acl, ...flags, allowRules: [] }), /Invalid/);
  }
});

test('preparation ownership excludes concurrent transactions and keeps a permanent lock inode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'af-preparation-lock-'));
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const input = { home, workspaceId: WORKSPACE, provider: 'codex' as const, assertCurrent: () => {} };
  const owner = withSkillPreparationTransaction(input, async () => { entered(); await blocked; });
  try {
    await Promise.race([started, owner.then(() => { throw new Error('Owner ended before entering.'); })]);
    const before = await stat(join(skillPreparationScopeRoot(home, WORKSPACE, 'codex'), '.LOCK'));
    let unauthorized = false;
    await assert.rejects(withSkillPreparationTransaction({ ...input, timeoutMs: 50 }, async () => { unauthorized = true; }), /not granted/);
    assert.equal(unauthorized, false);
    await withSkillPreparationTransaction({ ...input, provider: 'claude' }, async () => {});
    release(); await owner;
    await withSkillPreparationTransaction(input, async () => {});
    const after = await stat(join(skillPreparationScopeRoot(home, WORKSPACE, 'codex'), '.LOCK'));
    assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  } finally { release(); await owner.catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

test('stop does not release ownership before underlying preparation settles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'af-preparation-stop-'));
  let stopped = false, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const input = { home, workspaceId: WORKSPACE, provider: 'codex' as const,
    assertCurrent: () => { if (stopped) throw new Error('fixture stopped'); } };
  const owner = withSkillPreparationTransaction(input, async () => { entered(); await blocked; });
  const settled = owner.then(() => null, error => error as Error);
  try {
    await Promise.race([started, settled.then(error => { throw error || new Error('Owner did not enter.'); })]);
    stopped = true;
    await assert.rejects(withSkillPreparationTransaction({ ...input, assertCurrent: () => {}, timeoutMs: 50 }, async () => {}), /not granted/);
    release(); assert.match((await settled)!.message, /fixture stopped/);
    await withSkillPreparationTransaction({ ...input, assertCurrent: () => {} }, async () => {});
  } finally { release(); await settled; await rm(home, { recursive: true, force: true }); }
});

test('a symlinked preparation ancestor is rejected before locking or callback execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'af-preparation-parent-'));
  const foreign = await mkdtemp(join(tmpdir(), 'af-preparation-foreign-'));
  try {
    await symlink(foreign, join(home, 'relay'), process.platform === 'win32' ? 'junction' : 'dir');
    let entered = false;
    await assert.rejects(withSkillPreparationTransaction({ home, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {} },
      async () => { entered = true; }), /real directory/);
    assert.equal(entered, false);
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(foreign)), []);
  } finally { await rm(home, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }); }
});

test('ancestors above the configured home are checked before recursive creation', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'af-preparation-above-'));
  const foreign = await mkdtemp(join(tmpdir(), 'af-preparation-target-'));
  try {
    await symlink(foreign, join(owned, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(withSkillPreparationTransaction({ home: join(owned, 'link', 'new-home'),
      workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {} }, async () => {}), /ancestor/);
    assert.deepEqual(await readdir(foreign), []);
  } finally { await rm(owned, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }); }
});

test('existing non-private preparation directories are rejected without permission repair', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'af-preparation-mode-'));
  try {
    const root = skillPreparationScopeRoot(home, WORKSPACE, 'codex');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o777);
    await assert.rejects(withSkillPreparationTransaction({ home, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {} }, async () => {}), /private/);
    assert.equal((await stat(root)).mode & 0o777, 0o777);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const interruption of ['normal release', 'process death'] as const) {
  test(`two-process preparation locking: ${interruption}`, { timeout: 20000 }, async context => {
    const home = await mkdtemp(join(tmpdir(), 'af-preparation-process-'));
    const moduleUrl = new URL('./skillPreparationTransaction.js', import.meta.url).href;
    const script = `import { withSkillPreparationTransaction } from ${JSON.stringify(moduleUrl)};
      await withSkillPreparationTransaction({home:process.argv[1], workspaceId:${JSON.stringify(WORKSPACE)},
        provider:'codex', assertCurrent:()=>{}}, async()=>{
          console.log('locked'); await new Promise(resolve=>process.stdin.once('data',resolve));
        });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], { stdio: ['pipe', 'pipe', 'pipe'] });
    const abortChild = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    context.signal.addEventListener('abort', abortChild, { once: true });
    let stderr = '', output = '', timer: NodeJS.Timeout | undefined;
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const exit = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    const locked = new Promise<void>(resolveLock => child.stdout.on('data', bytes => {
      output += bytes.toString(); if (output.includes('locked\n') || output.includes('locked\r\n')) resolveLock();
    }));
    try {
      await Promise.race([locked, exit.then(code => { throw new Error(`Child exited before lock: ${code}: ${stderr}`); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Child lock observation timed out.')), 10000); })]);
      clearTimeout(timer);
      const input = { home, workspaceId: WORKSPACE, provider: 'codex' as const, assertCurrent: () => {} };
      await assert.rejects(withSkillPreparationTransaction({ ...input, timeoutMs: 50 }, async () => {}), /not granted/);
      if (interruption === 'process death') child.kill('SIGKILL'); else child.stdin.end('release\n');
      const code = await exit;
      if (interruption === 'normal release') assert.equal(code, 0);
      await withSkillPreparationTransaction(input, async () => {});
    } finally {
      context.signal.removeEventListener('abort', abortChild);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit.catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('actual relay holds preparation transaction ownership through staging publication', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /await withSkillPreparationTransaction\(/);
  assert.ok(relay.indexOf('await withSkillPreparationTransaction(') < relay.indexOf('await prepareSkillUpdate('));
  assert.ok(relay.indexOf('await prepareSkillUpdate(') < relay.indexOf("'PREPARED.json'"));
});

test('preparation scope is domain separated and workspace/provider isolated', async () => {
  const module = await import('./skillPreparationTransaction.js' as string) as {
    skillPreparationScopeRoot: (home: string, workspaceId: string, provider: string) => string;
  };
  const a = module.skillPreparationScopeRoot('/synthetic/home', '11111111-1111-4111-8111-111111111111', 'codex');
  assert.notEqual(a, module.skillPreparationScopeRoot('/synthetic/home', '22222222-2222-4222-8222-222222222222', 'codex'));
  assert.notEqual(a, module.skillPreparationScopeRoot('/synthetic/home', '11111111-1111-4111-8111-111111111111', 'claude'));
  assert.throws(() => module.skillPreparationScopeRoot('/synthetic/home', '../foreign', 'codex'));
  assert.throws(() => module.skillPreparationScopeRoot('/synthetic/home', '11111111-1111-4111-8111-111111111111', 'unknown'));
});
