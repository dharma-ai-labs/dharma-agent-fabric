import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { run, commandExitCode, loadAgentFabricOnboardingContract } from './index.js';

const flags = ['bootstrap', '--setup-reference', '11111111-1111-4111-8111-111111111111',
  '--setup-recipient-membership-id', '22222222-2222-4222-8222-222222222222',
  '--setup-scope-digest', `sha256:${'a'.repeat(64)}`, '--setup-contract-digest', `sha256:${(await loadAgentFabricOnboardingContract()).sha256}`,
  '--portal-url', 'https://hq.example', '--organization-id', 'org_demo', '--policy-revision', 'policy-v1', '--complete'];

test('reference dry-run is noninteractive, performs no repository/session/store/network effects', async () => {
  const result = await run([...flags, '--workspace', '/does-not-exist/never-touch', '--dry-run']) as Record<string,unknown>;
  assert.equal(result.ok, true); assert.equal(result.stage, 'plan'); assert.equal(result.effects, false);
  assert.equal(result.setupTransport, 'public_claim_v1'); assert.equal(result.grantRedeemed, false);
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./index.js',import.meta.url)),...flags,'--dry-run'],{timeout:10_000});
  assert.equal(JSON.parse(stdout).effects,false); assert.equal(stderr,'');
  assert.equal(commandExitCode(flags,{ok:true,stage:'plan',effects:false}),1);
  assert.equal(commandExitCode([...flags,'--dry-run'],{ok:true,stage:'plan',effects:false}),0);
});
test('reference bootstrap rejects join, disabled startup and incomplete context before effects', async () => {
  for (const extra of [['--join-repository-binding-id','33333333-3333-4333-8333-333333333333'],
    ['--no-relay-daemon'],['--setup-scope-digest','invalid'],['--setup-reference','invalid']]) {
    await assert.rejects(run([...flags,...extra,'--dry-run']),/setup_claim_(source_required|context_invalid)/);
  }
  await assert.rejects(run(flags.filter(v=>v!=='--complete').concat('--dry-run')),/setup_claim_source_required/);
});
test('reference bootstrap rejects a different installed operating contract before repository or enrollment effects', async () => {
  await assert.rejects(run([...flags, '--workspace', '/does-not-exist/never-touch', '--setup-contract-digest', `sha256:${'f'.repeat(64)}`, '--dry-run']), /setup_claim_contract_mismatch/);
});
