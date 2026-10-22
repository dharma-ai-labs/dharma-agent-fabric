import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { approvedRecoveryContract, assertRecoverySource, publishRecoveryContract, runRecoveryContractCommand } from './publish-recovery-contracts.mjs';

const root = resolve(import.meta.dirname, '..');
const baseline = '544ead13a212f1ba6253a3845def61baf5c92dbb';
const head = 'a'.repeat(40), name = '@dharma-ai-labs/agent-fabric-contracts';
const paths = ['packages/contracts/package.json', 'packages/cli/package.json', 'packages/lifecycle-adapter/package.json', 'package-lock.json', 'packages/cli/src/index.ts','package.json'];
const git = path => execFileSync('git', ['show', `${baseline}:${path}`], {cwd: root, encoding: 'utf8', maxBuffer: 4*1024*1024});
function snapshot() {
  const original = Object.fromEntries(paths.map(path => [path, path.endsWith('.json') ? JSON.parse(git(path)) : git(path)]));
  const current = structuredClone(original);
  current['package.json'].scripts['publish:recovery-contracts']='node scripts/publish-recovery-contracts.mjs';
  current['package.json'].scripts['pack:verify']=current['package.json'].scripts['pack:verify']
    .replace('scripts/verify-package-pins.test.mjs','scripts/verify-package-pins.test.mjs scripts/publish-recovery-contracts.test.mjs');
  current[paths[0]].version = '0.1.17';
  current[paths[1]].version = '0.2.210';
  current[paths[1]].dependencies[name] = current[paths[2]].dependencies[name] = '0.1.17';
  const lock = current['package-lock.json'];
  lock.packages['packages/contracts'].version = '0.1.17';
  lock.packages['packages/cli'].version = '0.2.210';
  lock.packages['packages/cli'].dependencies[name] = lock.packages['packages/lifecycle-adapter'].dependencies[name] = '0.1.17';
  for(const suffix of ['provider-adapters','task-runner'])lock.packages[`packages/${suffix}/node_modules/${name}`]={
    version:'0.1.16',resolved:'https://registry.npmjs.org/@dharma-ai-labs/agent-fabric-contracts/-/agent-fabric-contracts-0.1.16.tgz',
    integrity:'sha512-ccumvrKW2MRxVobFxpmEYXzOdY7syggdPswC8BBuuLnnjSvOUz0tYtwZEaF7n1A4RK6yNuttmavZ/rCV5smtMQ==',
    license:'MIT',dependencies:structuredClone(original[paths[0]].dependencies)};
  current[paths[4]] = original[paths[4]].replace("const VERSION = '0.2.209';", "const VERSION = '0.2.210';");
  return {head, ref: 'refs/heads/main', baselineTree: 'f1f25634814736a88b277c58a3519d1d786bdbb6',
    dirty: '', changed: [...paths], untracked: [], baseline: original, current};
}
test('recovery release selects only contracts017, never the prepared CLI210 or relay', () => {
  assert.deepEqual(approvedRecoveryContract, {workspace:'packages/contracts', name, version:'0.1.17'});
  assert.doesNotThrow(() => assertRecoverySource(head, snapshot()));
});
for (const mismatch of ['head','ref','baselineTree','dirty','untracked','source','manifest','lock','nested-lock','removed-unrelated-lock','cli']) {
  test(`source ${mismatch} is rejected before publication`, () => {
    const s = snapshot();
    if (mismatch === 'head') s.head = 'b'.repeat(40);
    if (mismatch === 'ref') s.ref = 'refs/heads/candidate';
    if (mismatch === 'baselineTree') s.baselineTree = 'b'.repeat(40);
    if (mismatch === 'dirty') s.dirty = 'M packages/contracts/src/index.ts';
    if (mismatch === 'untracked') s.untracked = ['unknown-file'];
    if (mismatch === 'source') s.changed.push('packages/contracts/src/signingRecovery.ts');
    if (mismatch === 'manifest') s.current[paths[0]].dependencies = {};
    if (mismatch === 'lock') s.current['package-lock.json'].packages['packages/contracts'].version = '9.0.0';
    if (mismatch === 'nested-lock') s.current['package-lock.json'].packages[`packages/provider-adapters/node_modules/${name}`].integrity='changed';
    if (mismatch === 'removed-unrelated-lock') delete s.current['package-lock.json'].packages['packages/sdk'];
    if (mismatch === 'cli') s.current[paths[4]] += '\n// unrelated source';
    assert.throws(() => assertRecoverySource(head, s));
  });
}
function fixture({existing = false, dryRun = false} = {}) {
  const events = [], packed = {name,version:'0.1.17',filename:'dharma-ai-labs-agent-fabric-contracts-0.1.17.tgz',
      integrity:'sha512-'+Buffer.alloc(64,7).toString('base64')},
    metadata = {name, version:'0.1.17', dist:{integrity:packed.integrity}};
  let published = false;
  const io = { verifySource: async value => { assertRecoverySource(value,snapshot()); events.push('source'); },
    manifest: async item => ({name:item.name,version:item.version}), pack: async () => packed,
    lookup: async () => existing || published ? metadata : null,
    verifyPublished: async (item, tarball, record, source) => { assert.equal(source,head); events.push('provenance'); },
    publish: async item => { assert.deepEqual(item,approvedRecoveryContract); published=true;events.push('publish'); } };
  return {io,events,metadata,run:()=>publishRecoveryContract(head,io,{dryRun})};
}
test('default is a plan; no publish or credential-dependent effect occurs', async () => {
  const f = fixture(); assert.equal((await publishRecoveryContract(head,f.io)).state,'ready_not_published');
  assert.deepEqual(f.events,['source']);
});
test('one publication is followed by immutable-artifact readback', async () => {
  const f = fixture(); assert.equal((await f.run()).state,'published_verified');
  assert.deepEqual(f.events,['source','publish','provenance']);
});
test('an existing identical artifact is verified, never republished', async () => {
  const f = fixture({existing:true}); assert.equal((await f.run()).state,'existing_verified');
  assert.deepEqual(f.events,['source','provenance']);
});
for (const field of ['name','version','filename','integrity']) {
  test(`malformed packed ${field} is refused before any publication`, async () => {
    const f=fixture(), original=f.io.pack;
    f.io.pack=async()=>({...await original(),[field]:'unexpected'});
    await assert.rejects(f.run());
    assert.deepEqual(f.events,['source']);
  });
}
test('a non-boolean write option cannot opt into publication', async () => {
  const f=fixture();
  await assert.rejects(publishRecoveryContract(head,f.io,{dryRun:null}));
  assert.deepEqual(f.events,[]);
});
for (const defect of ['manifest','existing-integrity','source-denied','unknown-publication','missing-after-write','provenance']) {
  test(`${defect} stops without a blind publish retry`, async () => {
    const f = fixture({existing:defect==='existing-integrity'});
    if (defect==='manifest') f.io.manifest=async()=>({name,version:'0.1.16'});
    if (defect==='existing-integrity') f.metadata.dist.integrity='changed';
    if (defect==='source-denied') f.io.verifySource=async()=>{throw Error('source denied');};
    if (defect==='unknown-publication') f.io.publish=async()=>{f.events.push('publish');throw Error('uncertain');};
    if (defect==='missing-after-write') f.io.lookup=async()=>null;
    if (defect==='provenance') f.io.verifyPublished=async()=>{throw Error('wrong source');};
    await assert.rejects(f.run());
    assert.ok(f.events.filter(v=>v==='publish').length<=1);
  });
}
test('manual contract-only route uses the bounded main publisher and excludes Python', () => {
  const workflow = parse(readFileSync(resolve(root,'.github/workflows/publish.yml'),'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.contracts_only.type,'boolean');
  const step = workflow.jobs.publish.steps.find(item=>item.name==='Publish public workspaces');
  assert.match(step.run,/if \[ "\$CONTRACTS_ONLY" = "true" \]; then\s+npm run publish:recovery-contracts -- --expected-head "\$EXPECTED_HEAD" --publish\s+exit 0\s+fi/);
  assert.match(step.run,/ONBOARDING_ONLY.*true.*CONTRACTS_ONLY.*true/s);
  assert.match(workflow.jobs['publish-python'].if,/inputs.contracts_only/);
});
test('contracts-only source admission precedes every generic artifact/attestation effect', () => {
  const workflow=parse(readFileSync(resolve(root,'.github/workflows/publish.yml'),'utf8'));
  const steps=workflow.jobs.publish.steps, admission=steps.findIndex(item=>item.name==='Validate publication scope');
  assert.ok(admission>=0);
  assert.match(steps[admission].run,/--expected-head "\$EXPECTED_HEAD" --admission-only/);
  assert.match(steps[admission].run,/ONBOARDING_ONLY.*true.*CONTRACTS_ONLY.*true/s);
  for(const [name,condition] of [
    ['Build release artifacts',"!(github.event_name == 'workflow_dispatch' && (inputs.contracts_only || inputs.artifacts_only))"],
    ['Attest release artifacts',"!(github.event_name == 'workflow_dispatch' && inputs.contracts_only)"],
    ['Qualify execution artifacts without publication',"github.event_name == 'workflow_dispatch' && inputs.artifacts_only"],
    ['Retain qualified execution artifacts',"github.event_name == 'workflow_dispatch' && inputs.artifacts_only"],
  ]){
    const index=steps.findIndex(item=>item.name===name);
    assert.ok(admission<index);
    assert.equal(steps[index].if,condition);
  }
  assert.ok(admission<steps.findIndex(item=>item.run==='npm ci'));
});
test('admission-only performs source verification and no pack/network/publication callbacks',async()=>{
  const f=fixture();
  assert.deepEqual(await runRecoveryContractCommand(['--expected-head',head,'--admission-only'],f.io),{state:'source_admitted',head});
  assert.deepEqual(f.events,['source']);
});
for(const args of [[],['--expected-head',head,'--admission-only','--publish'],['--expected-head',head,'--force'],['--expected-head','wrong','--admission-only']]){
  test(`invalid or conflicting command is refused before callbacks: ${args.join(' ')}`,async()=>{
    const f=fixture();await assert.rejects(runRecoveryContractCommand(args,f.io));assert.deepEqual(f.events,[]);
  });
}
