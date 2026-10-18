import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {approvedPackages as historicalPackages,lookupPublishedArtifact,verifyPublishedProvenance} from './publish-onboarding-release.mjs';

export const maintenanceBaseline=Object.freeze({commit:'4ed6b35547ac6d05feb9d29293b57d38b2565933',
  tree:'86f7887b6f569721a1fe786f221484bad1736b53'});
export const reviewedWorkflowHash='473304bb901ab151a5a805a821dd74d592fbc0d64335ccf65f92e4dc92a44c80';
export const reviewedWorkflowTestHash='b2c2180ebd84bfccc312a90655505aa4ad117b4c312bf43cd49560d04bcc693e';
export const reviewedReleaseTestHash='f02595a575c6639de371047ca1f30537835a8e6ddb9d7e2916102dd9fd369c8c';
const packageItem=(workspace,version)=>Object.freeze({workspace:'packages/'+workspace,
  name:'@dharma-ai-labs/'+(workspace==='cli'?'agent-fabric':'agent-fabric-'+workspace),version});
export const maintenancePackages=Object.freeze([
  packageItem('contracts','0.1.18'),
  ...historicalPackages.filter(item=>['packages/provider-adapters','packages/task-runner','packages/evidence-reduction','packages/secure-store'].includes(item.workspace)),
  packageItem('relay-client','0.2.34'),packageItem('local-vault','0.1.32'),packageItem('cli','0.2.210')]);
const allowedPaths=new Set(['scripts/publish-device-maintenance.mjs','scripts/publish-device-maintenance.test.mjs',
  'package.json','.github/workflows/publish.yml','scripts/publish-workflow.test.mjs']);
const textHash=value=>createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');
// The workflow independently pins this script. Normalize only that data pin to
// avoid a circular workflow/script hash; all executable workflow bytes stay bound.
export const maintenanceWorkflowHash=value=>textHash(value.replace(/^(\s*MAINTENANCE_PUBLISHER_SHA256:) [a-f0-9]{64}\r?$/gm,'$1 <publisher-pin>'));
export function readMaintenanceRemoteMain(git){
  const current=git('ls-remote','--exit-code','origin','refs/heads/main');
  assert.match(current,/^[a-f0-9]{40}\trefs\/heads\/main$/,'exact remote main read required');
  return current.slice(0,40);
}

export function assertMaintenanceSource(expectedHead,snapshot){
  assert.match(expectedHead??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  assert.equal(snapshot.head,expectedHead,'dispatched source mismatch');
  assert.equal(snapshot.remoteMain,expectedHead,'current remote main required');
  assert.equal(snapshot.ref,'refs/heads/main','main-only publication');
  assert.match(snapshot.expectedPublisherHash??'',/^[a-f0-9]{64}$/,'independent publisher pin required');
  assert.equal(snapshot.publisherHash,snapshot.expectedPublisherHash,'unreviewed publisher implementation');
  assert.equal(snapshot.baselineTree,maintenanceBaseline.tree,'qualified source baseline mismatch');
  assert.equal(snapshot.dirty,'','dirty source');
  assert.ok(snapshot.changed.every(path=>allowedPaths.has(path)),'unreviewed source delta');
  assert.ok(snapshot.untracked.every(path=>path.startsWith('release/')),'untracked source');
  const expected=structuredClone(snapshot.baselineManifest),anchor='scripts/publish-recovery-contracts.test.mjs';
  assert.equal(expected.scripts['pack:verify'].split(anchor).length,2,'single pack verifier anchor required');
  expected.scripts['pack:verify']=expected.scripts['pack:verify'].replace(anchor,anchor+' scripts/publish-device-maintenance.test.mjs');
  expected.scripts['publish:device-maintenance']='node scripts/publish-device-maintenance.mjs';
  assert.deepEqual(snapshot.manifest,expected,'unreviewed root manifest delta');
  assert.equal(textHash(snapshot.lock.trim()),textHash(snapshot.baselineLock.trim()),'unreviewed lock delta');
  assert.deepEqual(snapshot.manifests,snapshot.baselineManifests,'unreviewed package manifest delta');
  for(const item of maintenancePackages){
    const manifest=snapshot.manifests[item.workspace+'/package.json'];
    assert.equal(manifest?.name,item.name,'package identity mismatch');
    assert.equal(manifest.version,item.version,'qualified package version mismatch');
  }
  assert.equal(snapshot.workflowHash,reviewedWorkflowHash,'unreviewed publisher workflow');
  assert.equal(snapshot.workflowTestHash,reviewedWorkflowTestHash,'unreviewed workflow tests');
  assert.equal(snapshot.releaseTestHash,reviewedReleaseTestHash,'unreviewed release tests');
}
function assertPacked(item,packed){
  assert.equal(packed.name,item.name,'packed name mismatch');assert.equal(packed.version,item.version,'packed version mismatch');
  assert.equal(packed.filename,item.name.slice(1).replace('/','-')+'-'+item.version+'.tgz','packed filename mismatch');
  assert.match(packed.integrity??'',/^sha512-[A-Za-z0-9+/]{86}==$/,'packed integrity malformed');
  assert.equal('sha512-'+Buffer.from(packed.integrity.slice(7),'base64').toString('base64'),packed.integrity,'packed integrity noncanonical');
  if(item.existingArtifact)assert.equal(packed.integrity,item.existingArtifact.integrity,'immutable artifact changed');
}
function registryUrl(value){
  const url=new URL(value);assert.equal(url.origin,'https://registry.npmjs.org','foreign registry URL');
  assert.equal(url.username+url.password+url.search+url.hash,'','registry URL credentials or parameters forbidden');return url;
}
function assertArtifact(item,packed,metadata){
  assert.equal(metadata.name,item.name,'registry name mismatch');assert.equal(metadata.version,item.version,'registry version mismatch');
  assert.equal(metadata.dist?.integrity,packed.integrity,'registry artifact changed');
  assert.equal(decodeURIComponent(registryUrl(metadata.dist?.tarball).pathname),'/'+item.name+'/-/'+packed.filename,'registry tarball mismatch');
  assert.ok(registryUrl(metadata.dist?.attestations?.url).pathname.startsWith('/-/npm/v1/attestations/'),'registry attestation mismatch');
}
/** No automatic publish retry: every pack/existing artifact is validated first.
 * A partial write stops the transaction and must be reconciled at the same SHA. */
export async function publishDeviceMaintenance(expectedHead,io,{publish=false}={}){
  assert.equal(typeof publish,'boolean','explicit boolean publish mode required');
  await io.verifySource(expectedHead);const prepared=[];
  for(const item of maintenancePackages){
    const manifest=await io.manifest(item);assert.equal(manifest.name,item.name);assert.equal(manifest.version,item.version);
    const packed=await io.pack(item);assertPacked(item,packed);const existing=await io.lookup(item,false);
    if(item.existingArtifact)assert.ok(existing,'immutable artifact missing; republish forbidden');
    if(existing){assertArtifact(item,packed,existing);await io.verifyPublished(item,packed,existing,item.existingArtifact?.source??expectedHead);}
    prepared.push({item,packed,existing});
  }
  if(!publish)return {state:'ready_not_published',head:expectedHead,packages:prepared.map(({item,packed,existing})=>({name:item.name,
    version:item.version,integrity:packed.integrity,state:existing?'existing_verified':'not_published'}))};
  for(const {item,packed,existing} of prepared){
    if(existing)continue;
    // Main may have moved while packs or registry receipts were checked.
    await io.verifySource(expectedHead);
    await io.publish(item,packed);
    const metadata=await io.lookup(item,true);assert.ok(metadata,'publication unconfirmed; reconcile before retry');
    assertArtifact(item,packed,metadata);await io.verifyPublished(item,packed,metadata,expectedHead);
  }
  return {state:'published_verified',head:expectedHead,packages:maintenancePackages.map(item=>({name:item.name,version:item.version}))};
}
export async function runMaintenanceCommand(args,io){
  assert.ok(args[0]==='--expected-head'&&(args.length===2||args.length===3&&['--admission-only','--publish'].includes(args[2])),
    'fixed release options only');assert.match(args[1]??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  if(args[2]==='--admission-only'){await io.verifySource(args[1]);return {state:'source_admitted',head:args[1]};}
  return publishDeviceMaintenance(args[1],io,{publish:args[2]==='--publish'});
}
async function publicGet(value,{json=true,timeout=30000}={}){
  const url=registryUrl(value),response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(response.status===404){await response.body?.cancel();return null;}
  assert.ok(response.ok,'registry HTTP '+response.status);
  return json?response.json():Buffer.from(await response.arrayBuffer());
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const root=resolve(import.meta.dirname,'..');let directory;
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
  const npm=(...args)=>{assert.ok(process.env.npm_execpath,'invoke packaging through npm');
    return execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:root,encoding:'utf8',
      stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:8*1024*1024}).trim();};
  const baseline=maintenanceBaseline.commit,hashFile=path=>textHash(readFileSync(join(root,path),'utf8'));
  const result=await runMaintenanceCommand(process.argv.slice(2),{
    verifySource:async expected=>{
      git('merge-base','--is-ancestor',baseline,'HEAD');
      const paths=git('ls-tree','-r','--name-only',baseline,'packages').split('\n').filter(path=>/^packages\/[^/]+\/package.json$/.test(path));
      assertMaintenanceSource(expected,{head:git('rev-parse','HEAD'),remoteMain:readMaintenanceRemoteMain(git),ref:process.env.GITHUB_REF,
        expectedPublisherHash:process.env.MAINTENANCE_PUBLISHER_SHA256,publisherHash:hashFile('scripts/publish-device-maintenance.mjs'),
        baselineTree:git('rev-parse',baseline+'^{tree}'),dirty:git('status','--porcelain','--untracked-files=no'),
        changed:git('diff','--name-only',baseline,'HEAD').split('\n').filter(Boolean),untracked:git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean),
        baselineManifest:JSON.parse(git('show',baseline+':package.json')),manifest:JSON.parse(readFileSync(join(root,'package.json'),'utf8')),
        baselineLock:git('show',baseline+':package-lock.json'),lock:readFileSync(join(root,'package-lock.json'),'utf8').trim(),
        baselineManifests:Object.fromEntries(paths.map(path=>[path,JSON.parse(git('show',baseline+':'+path))])),
        manifests:Object.fromEntries(paths.map(path=>[path,JSON.parse(readFileSync(join(root,path),'utf8'))])),
        workflowHash:maintenanceWorkflowHash(readFileSync(join(root,'.github/workflows/publish.yml'),'utf8')),workflowTestHash:hashFile('scripts/publish-workflow.test.mjs'),
        releaseTestHash:hashFile('scripts/publish-device-maintenance.test.mjs')});
    },manifest:async item=>JSON.parse(readFileSync(join(root,item.workspace,'package.json'),'utf8')),
    pack:async item=>{directory??=mkdtempSync(join(tmpdir(),'dharma-maintenance-release-'));
      return JSON.parse(npm('pack','--workspace',item.workspace,'--json','--pack-destination',directory))[0];},
    lookup:async(item,published)=>{const read=timeout=>publicGet('https://registry.npmjs.org/'+encodeURIComponent(item.name)+'/'+item.version,{timeout});
      return published?lookupPublishedArtifact(read):read(30000);},
    publish:async(item,packed)=>{
      console.log('Publishing '+item.name+'@'+item.version+' '+packed.integrity);
      console.log(npm('publish',join(directory,packed.filename),'--access','public','--tag','latest','--provenance'));
    },verifyPublished:async(item,packed,metadata,source)=>{
      const bytes=await publicGet(metadata.dist.tarball,{json:false});assert.ok(bytes,'published tarball missing');
      assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),packed.integrity,'tarball integrity mismatch');
      await verifyPublishedProvenance(item,packed,source,timeout=>publicGet(metadata.dist.attestations.url,{timeout}));
    }});
  console.log(JSON.stringify(result));
}
