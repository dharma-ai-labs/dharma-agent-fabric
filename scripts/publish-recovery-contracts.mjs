import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvedPackages, lookupPublishedArtifact, verifyPublishedProvenance } from './publish-onboarding-release.mjs';

const baseline = '544ead13a212f1ba6253a3845def61baf5c92dbb';
const baselineTree = 'f1f25634814736a88b277c58a3519d1d786bdbb6';
const contractName = '@dharma-ai-labs/agent-fabric-contracts';
export const approvedRecoveryContract = Object.freeze({workspace:'packages/contracts',name:contractName,version:'0.1.17'});
const dataPaths = ['package.json','packages/contracts/package.json','packages/cli/package.json',
  'packages/lifecycle-adapter/package.json','package-lock.json','packages/cli/src/index.ts'];
const allowed = new Set([...dataPaths, 'scripts/publish-recovery-contracts.mjs','scripts/publish-recovery-contracts.test.mjs',
  'scripts/publish-onboarding-release.test.mjs','scripts/publish-workflow.test.mjs','.github/workflows/publish.yml']);
const text = v => v.replace(/\r\n/g,'\n');
export function assertRecoverySource(expectedHead, snapshot) {
  assert.match(expectedHead || '',/^[a-f0-9]{40}$/,'explicit reviewed main required');
  assert.equal(snapshot.head,expectedHead,'dispatched source mismatch');
  assert.equal(snapshot.ref,'refs/heads/main','main only');
  assert.equal(snapshot.baselineTree,baselineTree,'baseline mismatch');
  assert.equal(snapshot.dirty,'','dirty source');
  assert.ok(snapshot.untracked.every(path=>path.startsWith('release/')),'untracked source');
  assert.ok(snapshot.changed.every(path=>allowed.has(path)),'unreviewed source delta');
  const expected = structuredClone(snapshot.baseline);
  expected['package.json'].scripts['publish:recovery-contracts'] = 'node scripts/publish-recovery-contracts.mjs';
  assert.equal(expected['package.json'].scripts['pack:verify'].split('scripts/verify-package-pins.test.mjs').length,2,'single pack verifier anchor required');
  expected['package.json'].scripts['pack:verify']=expected['package.json'].scripts['pack:verify']
    .replace('scripts/verify-package-pins.test.mjs','scripts/verify-package-pins.test.mjs scripts/publish-recovery-contracts.test.mjs');
  expected['packages/contracts/package.json'].version='0.1.17';
  expected['packages/cli/package.json'].version='0.2.210';
  for (const path of ['packages/cli/package.json','packages/lifecycle-adapter/package.json']) expected[path].dependencies[contractName]='0.1.17';
  const lock=expected['package-lock.json'];
  lock.packages['packages/contracts'].version='0.1.17'; lock.packages['packages/cli'].version='0.2.210';
  for (const path of ['packages/cli','packages/lifecycle-adapter']) lock.packages[path].dependencies[contractName]='0.1.17';
  const retained=approvedPackages.find(item=>item.name===contractName && item.version==='0.1.16');
  assert.ok(retained?.existingArtifact?.integrity,'qualified contracts016 commitment required');
  for(const suffix of ['provider-adapters','task-runner'])lock.packages[`packages/${suffix}/node_modules/${contractName}`]={
    version:'0.1.16',resolved:'https://registry.npmjs.org/@dharma-ai-labs/agent-fabric-contracts/-/agent-fabric-contracts-0.1.16.tgz',
    integrity:retained.existingArtifact.integrity,license:expected['packages/contracts/package.json'].license,
    dependencies:structuredClone(expected['packages/contracts/package.json'].dependencies)};
  const previous="const VERSION = '0.2.209';", next="const VERSION = '0.2.210';";
  assert.equal(expected['packages/cli/src/index.ts'].split(previous).length,2,'single CLI version anchor required');
  expected['packages/cli/src/index.ts']=text(expected['packages/cli/src/index.ts']).replace(previous,next);
  const current=structuredClone(snapshot.current); current['packages/cli/src/index.ts']=text(current['packages/cli/src/index.ts']);
  assert.deepEqual(current,expected,'unreviewed manifest/lock/CLI source delta');
}
function assertArtifact(packed, metadata) {
  assert.equal(metadata.name,contractName,'registry name mismatch');
  assert.equal(metadata.version,'0.1.17','registry version mismatch');
  assert.equal(metadata.dist?.integrity,packed.integrity,'artifact integrity mismatch');
}
export async function publishRecoveryContract(expectedHead,io,{dryRun=true}={}) {
  assert.equal(typeof dryRun,'boolean','explicit boolean release mode required');
  await io.verifySource(expectedHead);
  const item=approvedRecoveryContract, manifest=await io.manifest(item);
  assert.equal(manifest.name,item.name,'package name mismatch'); assert.equal(manifest.version,item.version,'package version mismatch');
  const packed=await io.pack(item);
  assert.equal(packed.name,item.name,'packed name mismatch'); assert.equal(packed.version,item.version,'packed version mismatch');
  assert.equal(packed.filename,'dharma-ai-labs-agent-fabric-contracts-0.1.17.tgz','packed filename mismatch');
  assert.match(packed.integrity || '',/^sha512-[A-Za-z0-9+/]{86}==$/,'packed integrity invalid');
  assert.equal('sha512-'+Buffer.from(packed.integrity.slice(7),'base64').toString('base64'),packed.integrity,'packed integrity noncanonical');
  const existing=await io.lookup(item);
  if (existing) {
    assertArtifact(packed,existing); await io.verifyPublished(item,packed,existing,expectedHead);
    return {state:'existing_verified',package:item.name,version:item.version,integrity:packed.integrity};
  }
  if (dryRun) return {state:'ready_not_published',package:item.name,version:item.version,integrity:packed.integrity};
  await io.publish(item,packed);
  const published=await io.lookup(item,true);
  assert.ok(published,'publication unconfirmed; reconcile before retry');
  assertArtifact(packed,published); await io.verifyPublished(item,packed,published,expectedHead);
  return {state:'published_verified',package:item.name,version:item.version,integrity:packed.integrity};
}
export async function runRecoveryContractCommand(args,io) {
  assert.ok(args[0]==='--expected-head' && (args.length===2 || (args.length===3
    && ['--publish','--admission-only'].includes(args[2]))),'fixed release options only');
  assert.match(args[1] || '',/^[a-f0-9]{40}$/,'explicit reviewed main required');
  if(args[2]==='--admission-only') {
    await io.verifySource(args[1]);
    return {state:'source_admitted',head:args[1]};
  }
  return publishRecoveryContract(args[1],io,{dryRun:args[2]!=='--publish'});
}
async function publicBytes(url,{allowMissing=false,limit=8*1024*1024,timeout=30000}={}) {
  const parsed=new URL(url); assert.equal(parsed.origin,'https://registry.npmjs.org','registry origin required');
  assert.equal(parsed.username+parsed.password,'','URL credentials forbidden');
  const response=await fetch(parsed,{redirect:'error',signal:AbortSignal.timeout(timeout)});
  if (allowMissing && response.status===404) {await response.body?.cancel();return null;}
  assert.equal(response.ok,true,'registry read failed'); assert.ok(response.body,'registry body missing');
  const reader=response.body.getReader(),chunks=[]; let bytes=0;
  try {
    while (true) {const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
      assert.ok(bytes<=limit,'registry body too large');chunks.push(part.value);}
    return Buffer.concat(chunks);
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function publicJson(url,timeout=30000) {
  const bytes=await publicBytes(url,{allowMissing:true,limit:2*1024*1024,timeout});
  return bytes ? JSON.parse(bytes.toString('utf8')) : null;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const root=resolve(import.meta.dirname,'..');
    const git=(...values)=>execFileSync('git',values,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}).trim();
    const blob=path=>execFileSync('git',['show',`${baseline}:${path}`],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    const npm=(...values)=>{
      assert.ok(process.env.npm_execpath,'use npm run publish:recovery-contracts');
      return execFileSync(process.execPath,[process.env.npm_execpath,...values],{
        cwd:root,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
    };
    let directory;
    const packageDirectory=()=>directory ??= mkdtempSync(join(tmpdir(),'dharma-recovery-contracts-'));
    const outcome=await runRecoveryContractCommand(process.argv.slice(2),{
      verifySource: async expectedHead=>{
        git('merge-base','--is-ancestor',baseline,'HEAD');
        const original=Object.fromEntries(dataPaths.map(path=>[path,path.endsWith('.json')?JSON.parse(blob(path)):blob(path)]));
        const current=Object.fromEntries(dataPaths.map(path=>[path,path.endsWith('.json')?JSON.parse(readFileSync(join(root,path),'utf8')):readFileSync(join(root,path),'utf8')]));
        assertRecoverySource(expectedHead,{head:git('rev-parse','HEAD'),ref:process.env.GITHUB_REF,
          baselineTree:git('rev-parse',`${baseline}^{tree}`),dirty:git('status','--porcelain','--untracked-files=no'),
          changed:git('diff','--name-only',baseline,'HEAD').split('\n').filter(Boolean),
          untracked:git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean),baseline:original,current});
      },
      manifest: async item=>JSON.parse(readFileSync(join(root,item.workspace,'package.json'),'utf8')),
      pack: async item=>JSON.parse(npm('pack','--workspace',item.workspace,'--json','--pack-destination',packageDirectory()))[0],
      lookup: async (item,afterWrite=false)=>{
        const read=timeout=>publicJson(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`,timeout);
        return afterWrite?lookupPublishedArtifact(read):read(30000);
      },
      publish: async (item,packed)=>{
        assert.equal(process.env.GITHUB_ACTIONS,'true','official workflow required');
        npm('publish',join(packageDirectory(),packed.filename),'--access','public','--tag','latest','--provenance');
      },
      verifyPublished: async (item,packed,metadata,source)=>{
        assert.equal(metadata.dist?.tarball,'https://registry.npmjs.org/@dharma-ai-labs/agent-fabric-contracts/-/agent-fabric-contracts-0.1.17.tgz','exact tarball required');
        const bytes=await publicBytes(metadata.dist.tarball);
        assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),packed.integrity,'tarball mismatch');
        const url=new URL(metadata.dist?.attestations?.url);
        assert.equal(url.origin,'https://registry.npmjs.org','attestation origin mismatch');
        assert.ok(url.pathname.startsWith('/-/npm/v1/attestations/'),'attestation path mismatch');
        await verifyPublishedProvenance(item,packed,source,timeout=>publicJson(url.href,timeout));
      },
    });
    console.log(JSON.stringify(outcome));
  } catch {console.error('recovery_contract_release_failed; reconcile source/artifact state before another attempt');process.exitCode=1;}
}
