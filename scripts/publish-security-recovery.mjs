import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lookupPublishedArtifact} from './publish-onboarding-release.mjs';
import {assertReleaseProvenance,packPreservedDependency} from './publish-signing-upgrade.mjs';
import {readMaintenanceRemoteMain} from './publish-device-maintenance.mjs';

function freeze(value) {
  if(value && typeof value==='object') {
    for(const item of Object.values(value))freeze(item);
    Object.freeze(value);
  }
  return value;
}
export const securityRelease = freeze(JSON.parse(readFileSync(new URL('./security-recovery-release.json', import.meta.url), 'utf8')));
export const securityPins = Object.freeze({manifest:'ca692b35e73020a37586242a272adf96acb2b5add6865f4c6adea10f0303705d',workflow:'2f923ca96bc8589e28463e033dfccbaebd8da6b3d40f2ff1623eb97d7accdb25',tests:'5ef2fd50f2b8e3acf83e4a29162cf722c9022308e7dcb0aea8a4ccc8a0a0bd69'});
export const securityTextHash=value=>createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');
export const securityWorkflowHash=value=>securityTextHash(value.replace(
  /^(\s*SECURITY_PUBLISHER_SHA256:) [a-f0-9]{64}\r?$/gm,'$1 <publisher-pin>'));

export function assertPreservedSecurityStore(item,snapshot) {
  assert.equal(item.name,'@dharma-ai-labs/agent-fabric-secure-store','fixed historical secure-store only');
  assert.equal(item.version,'0.1.10','fixed historical secure-store version');
  assert.equal(snapshot.integrity,item.integrity,'historical secure-store integrity mismatch');
  assert.deepEqual(snapshot.sourceChanges,['packages/secure-store/src/windowsEnrollmentAnchor.test.ts'],
    'unreviewed secure-store source drift');
  assert.deepEqual(snapshot.sourceChanges,item.preserveOriginal.sourceChanges,'secure-store source contract drift');
  assert.deepEqual(snapshot.publishedManifest,snapshot.localManifest,'historical secure-store manifest drift');
  const names=['dist/index.js','dist/windowsEnrollmentAnchor.js','dist/windowsFreshRead.js'];
  for(const record of [item.preserveOriginal.runtimeHashes,snapshot.publishedRuntime,snapshot.localRuntime]){
    assert.deepEqual(Object.keys(record).sort(),names,'historical secure-store runtime set drift');
  }
  for(const name of names){
    const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest(snapshot.publishedRuntime[name]),item.preserveOriginal.runtimeHashes[name],'published secure-store runtime drift');
    assert.equal(digest(snapshot.localRuntime[name]),item.preserveOriginal.runtimeHashes[name],'local secure-store runtime drift');
  }
}

export async function packHistoricalSecurityStore(item,root,directory,git) {
  assert.equal(item.name,'@dharma-ai-labs/agent-fabric-secure-store','fixed historical secure-store only');
  assert.equal(item.version,'0.1.10','fixed historical secure-store version');
  assert.equal(item.workspace,'packages/secure-store','fixed historical secure-store workspace');
  const filename='dharma-ai-labs-agent-fabric-secure-store-0.1.10.tgz';
  const bytes=await publicGet('https://registry.npmjs.org/@dharma-ai-labs/agent-fabric-secure-store/-/agent-fabric-secure-store-0.1.10.tgz',false);
  assert.ok(bytes&&bytes.length<=131072,'bounded historical secure-store artifact required');
  const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  assert.equal(integrity,item.integrity,'historical secure-store integrity mismatch');
  const file=join(directory,filename);writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
  const tar=(...args)=>execFileSync('tar',args,{timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  const entries=tar('-tzf',file).toString('utf8').trim().split(/\r?\n/);
  assert.ok(entries.length>0&&entries.length<1000&&new Set(entries).size===entries.length,'bounded unique secure-store entries required');
  assert.ok(entries.every(p=>p.startsWith('package/')&&!p.includes('\\')&&!p.split('/').includes('..')&&!p.includes('\0')),'unsafe secure-store entry');
  const runtime=entries.filter(p=>p.startsWith('package/dist/')&&p.endsWith('.js')&&!p.endsWith('.test.js'));
  const publishedRuntime=Object.fromEntries(runtime.map(p=>[p.slice(8),tar('-xOf',file,p)])),localRuntime={};
  function walk(relative){for(const entry of readdirSync(join(root,item.workspace,relative),{withFileTypes:true})){
    const name=relative+'/'+entry.name;assert.ok(!entry.isSymbolicLink(),'local secure-store symlink refused');
    if(entry.isDirectory())walk(name);
    else if(entry.isFile()&&name.endsWith('.js')&&!name.endsWith('.test.js'))localRuntime[name]=readFileSync(join(root,item.workspace,name));
  }}walk('dist');
  assertPreservedSecurityStore(item,{integrity,sourceChanges:git('diff','--name-only',item.source,'HEAD','--',item.workspace).split('\n').filter(Boolean),
    publishedManifest:JSON.parse(tar('-xOf',file,'package/package.json').toString('utf8')),
    localManifest:JSON.parse(readFileSync(join(root,item.workspace,'package.json'),'utf8')),publishedRuntime,localRuntime});
  return{name:item.name,version:item.version,filename,integrity,preservedOriginalArtifact:true};
}

export function assertSecuritySource(head,snapshot) {
  assert.match(head??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  for(const pin of Object.values(securityPins))assert.match(pin,/^[a-f0-9]{64}$/,'release pins not qualified');
  assert.equal(snapshot.head,head,'dispatched source mismatch');
  assert.equal(snapshot.remoteMain,head,'current remote main required');
  assert.equal(snapshot.ref,'refs/heads/main','main-only publication');
  assert.equal(snapshot.repository,'dharma-ai-labs/dharma-agent-fabric','publisher repository mismatch');
  assert.equal(snapshot.baselineTree,securityRelease.baseline.tree,'qualified baseline tree mismatch');
  assert.equal(snapshot.dirty,'','dirty source');
  assert.ok(snapshot.changed.every(path=>securityRelease.allowedPaths.includes(path)),'unreviewed source delta');
  assert.ok(snapshot.untracked.every(path=>path.startsWith('release/')),'untracked source');
  assert.match(snapshot.expectedPublisherHash??'',/^[a-f0-9]{64}$/,'independent publisher pin required');
  assert.equal(snapshot.publisherHash,snapshot.expectedPublisherHash,'unreviewed publisher bytes');
  assert.equal(snapshot.manifestHash,securityPins.manifest,'release manifest changed');
  assert.equal(snapshot.workflowHash,securityPins.workflow,'publisher workflow changed');
  assert.equal(snapshot.testHash,securityPins.tests,'release tests changed');
  const expected=structuredClone(snapshot.baselineManifest),anchor='scripts/publish-signing-upgrade.test.mjs &&';
  assert.equal(expected.scripts['pack:verify'].split(anchor).length,2,'single package-verifier anchor required');
  expected.scripts['pack:verify']=expected.scripts['pack:verify'].replace(anchor,
    'scripts/publish-signing-upgrade.test.mjs scripts/publish-security-recovery.test.mjs &&');
  expected.scripts['publish:security-recovery']='node scripts/publish-security-recovery.mjs';
  expected.scripts['test:security-recovery']='node --test scripts/publish-security-recovery.test.mjs';
  assert.deepEqual(snapshot.manifest,expected,'unreviewed root manifest delta');
  assert.equal(securityTextHash(snapshot.lock),securityTextHash(snapshot.baselineLock),'unreviewed lock delta');
  assert.deepEqual(snapshot.packageManifests,snapshot.baselinePackageManifests,'unreviewed package manifest delta');
}

function assertPacked(item,packed) {
  assert.equal(packed.name,item.name,'packed name mismatch');
  assert.equal(packed.version,item.version,'packed version mismatch');
  assert.equal(packed.filename,item.name.slice(1).replace('/','-')+'-'+item.version+'.tgz','packed filename mismatch');
  assert.match(packed.integrity??'',/^sha512-[A-Za-z0-9+/]{86}==$/,'packed integrity malformed');
  assert.equal(packed.integrity,item.integrity,'qualified artifact changed');
}
function registryUrl(value) {
  const url=new URL(value);
  assert.equal(url.origin,'https://registry.npmjs.org','foreign registry URL');
  assert.ok(url.username+url.password+url.search+url.hash==='','registry credentials or parameters forbidden');
  return url;
}
function assertArtifact(item,packed,metadata) {
  assert.equal(metadata.name,item.name,'registry name mismatch');
  assert.equal(metadata.version,item.version,'registry version mismatch');
  assert.equal(metadata.dist?.integrity,packed.integrity,'registry integrity mismatch');
  assert.equal(decodeURIComponent(registryUrl(metadata.dist?.tarball).pathname),
    '/'+item.name+'/-/'+item.name.split('/')[1]+'-'+item.version+'.tgz','registry tarball mismatch');
  assert.ok(registryUrl(metadata.dist?.attestations?.url).pathname.startsWith('/-/npm/v1/attestations/'),
    'registry attestation mismatch');
}

export function assertSecurityProvenance(item,packed,proof,head) {
  const expected=securityRelease.cohort.find(candidate=>candidate.name===item.name);
  assert.ok(expected,'unreviewed security package');
  assert.equal(item.version,expected.version,'provenance version mismatch');
  assert.equal(packed.integrity,expected.integrity,'provenance artifact mismatch');
  assert.match(head??'',/^[a-f0-9]{40}$/,'exact reviewed source required');
  assert.ok(Array.isArray(proof?.attestations),'SLSA provenance missing');
  assert.ok(proof.attestations.length>0&&proof.attestations.length<=16,'bounded provenance required');
  const statements=proof.attestations.map(entry=>{
    const payload=entry?.bundle?.dsseEnvelope?.payload;
    assert.ok(typeof payload==='string'&&payload.length<=8*1024*1024,'bounded provenance payload required');
    try{return JSON.parse(Buffer.from(payload,'base64').toString('utf8'));}
    catch{throw new Error('security_provenance_json_invalid');}
  });
  const statement=statements.find(value=>value.predicateType==='https://slsa.dev/provenance/v1');
  assert.ok(statement,'SLSA provenance missing');
  const definition=statement.predicate.buildDefinition,repository='https://github.com/dharma-ai-labs/dharma-agent-fabric';
  assert.deepEqual(definition.externalParameters.workflow,{ref:'refs/heads/main',repository,
    path:'.github/workflows/publish-security-recovery.yml'},'publisher workflow mismatch');
  assert.ok(definition.resolvedDependencies.some(value=>value.uri==='git+'+repository+'@refs/heads/main'
    && value.digest?.gitCommit===head),'publisher source mismatch');
  const digest=Buffer.from(packed.integrity.slice(7),'base64').toString('hex');
  assert.ok(statement.subject.some(value=>value.name==='pkg:npm/'+item.name.replace('@','%40')+'@'+item.version
    && value.digest?.sha512===digest),'publisher subject mismatch');
}

/** Validate the full closure before any write; partial results require reconciliation. */
export async function publishSecurityRecovery(head,io,{publish=false}={}) {
  assert.match(head??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  assert.equal(typeof publish,'boolean','explicit boolean publication mode required');
  await io.verifySource(head);
  for(const item of securityRelease.unchangedDependencies)await io.verifyImmutable(item);
  const prepared=[];
  for(const item of securityRelease.cohort) {
    const manifest=await io.manifest(item);
    assert.equal(manifest.name,item.name,'manifest name mismatch');
    assert.equal(manifest.version,item.version,'manifest version mismatch');
    const packed=await io.pack(item);assertPacked(item,packed);
    const existing=await io.lookup(item,false);
    if(existing) {
      assertArtifact(item,packed,existing);
      await io.verifyPublished(item,packed,existing,head);
    }
    prepared.push({item,packed,existing});
  }
  if(!publish)return {state:'ready_not_published',head,writes:0,
    packages:prepared.map(({item,packed,existing})=>({name:item.name,version:item.version,
      integrity:packed.integrity,state:existing?'existing_verified':'not_published'}))};
  let writes=0;
  for(const {item,packed,existing} of prepared) {
    if(existing)continue;
    await io.verifySource(head);
    await io.publish(item,packed);writes++;
    const metadata=await io.lookup(item,true);
    assert.ok(metadata,'publication unconfirmed; reconcile before retry');
    assertArtifact(item,packed,metadata);
    await io.verifyPublished(item,packed,metadata,head);
  }
  return {state:'published_verified',head,writes};
}

export async function runSecurityCommand(args,io) {
  assert.ok(args[0]==='--expected-head'&&(args.length===2||args.length===3&&['--admission-only','--publish'].includes(args[2])),
    'fixed security release options only');
  assert.match(args[1]??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  if(args[2]==='--admission-only') {
    await io.verifySource(args[1]);return {state:'source_admitted',head:args[1]};
  }
  return publishSecurityRecovery(args[1],io,{publish:args[2]==='--publish'});
}

export function securityNpmFailure(phase,error) {
  assert.ok(['pack','publish'].includes(phase),'fixed npm phase required');
  let code;
  try{code=JSON.parse(String(error?.stdout??'')).error?.code;}catch{}
  const known=['E401','E403','E404','EOTP','ENEEDAUTH','EINTEGRITY','EPUBLISHCONFLICT','ETARGET',
    'ENOTFOUND','ECONNRESET','ETIMEDOUT','EAI_AGAIN'];
  return new Error('security_npm_'+phase+'_failed_reconcile:'+(known.includes(code)?code:'UNCLASSIFIED'));
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(!/^[a-f0-9]{64}$/.test(process.env.SECURITY_PUBLISHER_SHA256??'')) {
    throw new Error('security_release_source_admission_not_qualified');
  }
  const root=resolve(import.meta.dirname,'..'),text=path=>readFileSync(join(root,path),'utf8');
  const git=(...args)=>{
    try{return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30_000,maxBuffer:8*1024*1024,
      stdio:['ignore','pipe','pipe']}).trim();}catch{throw new Error('security_git_read_unavailable');}
  };
  const gitText=path=>{
    try{return execFileSync('git',['show',securityRelease.baseline.commit+':'+path],{cwd:root,encoding:'utf8',
      timeout:30_000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}
    catch{throw new Error('security_baseline_read_unavailable');}
  };
  const npm=(...args)=>{
    assert.ok(process.env.npm_execpath,'normal npm execution required');
    try{return execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:root,encoding:'utf8',
      timeout:120_000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}
    catch(error){throw securityNpmFailure(args[0],error);}
  };
  let directory;
  const pack=async item=>{
    directory??=mkdtempSync(join(tmpdir(),'dharma-security-release-'));
    if(item.preserveOriginal){
      if(item.name==='@dharma-ai-labs/agent-fabric-secure-store')return packHistoricalSecurityStore(item,root,directory,git);
      return packPreservedDependency(item,root,directory,{git,read:(url,json)=>publicGet(url,json)});
    }
    const packed=JSON.parse(npm('pack','--workspace',item.workspace,'--json','--pack-destination',directory))[0];
    assertPacked(item,packed);
    assert.equal('sha512-'+createHash('sha512').update(readFileSync(join(directory,packed.filename))).digest('base64'),
      item.integrity,'actual packed bytes changed');
    return packed;
  };
  const lookup=(item,published)=>{
    const read=timeout=>publicGet('https://registry.npmjs.org/'+encodeURIComponent(item.name)+'/'+item.version,true,timeout);
    return published?lookupPublishedArtifact(read):read(30_000);
  };
  const verifyPublished=async(item,packed,metadata,source)=>{
    const bytes=await publicGet(metadata.dist.tarball,false);
    assert.ok(bytes,'published artifact unavailable');
    assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),packed.integrity,'published bytes mismatch');
    const proof=await lookupPublishedArtifact(timeout=>publicGet(metadata.dist.attestations.url,true,timeout));
    assert.ok(proof,'provenance unconfirmed; reconcile before retry');
    if(securityRelease.cohort.some(value=>value.name===item.name))assertSecurityProvenance(item,packed,proof,source);
    else assertReleaseProvenance(item,packed,proof,source);
  };
  const result=await runSecurityCommand(process.argv.slice(2),{
    verifySource:async head=>{
      git('merge-base','--is-ancestor',securityRelease.baseline.commit,'HEAD');
      const paths=git('ls-tree','-r','--name-only',securityRelease.baseline.commit,'packages').split('\n')
        .filter(path=>/^packages\/[^/]+\/package.json$/.test(path));
      assertSecuritySource(head,{head:git('rev-parse','HEAD'),remoteMain:readMaintenanceRemoteMain(git),
        ref:process.env.GITHUB_REF,repository:process.env.GITHUB_REPOSITORY,
        baselineTree:git('rev-parse',securityRelease.baseline.commit+'^{tree}'),
        dirty:git('status','--porcelain','--untracked-files=no'),
        changed:git('diff','--name-only',securityRelease.baseline.commit,'HEAD').split('\n').filter(Boolean),
        untracked:git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean),
        publisherHash:securityTextHash(text('scripts/publish-security-recovery.mjs')),
        expectedPublisherHash:process.env.SECURITY_PUBLISHER_SHA256,
        manifestHash:securityTextHash(text('scripts/security-recovery-release.json')),
        workflowHash:securityWorkflowHash(text('.github/workflows/publish-security-recovery.yml')),
        testHash:securityTextHash(text('scripts/publish-security-recovery.test.mjs')),
        baselineManifest:JSON.parse(gitText('package.json')),manifest:JSON.parse(text('package.json')),
        baselineLock:gitText('package-lock.json'),lock:text('package-lock.json'),
        baselinePackageManifests:Object.fromEntries(paths.map(path=>[path,JSON.parse(gitText(path))])),
        packageManifests:Object.fromEntries(paths.map(path=>[path,JSON.parse(text(path))]))});
    },
    verifyImmutable:async item=>{
      const manifest=JSON.parse(text(item.workspace+'/package.json'));
      assert.equal(manifest.name,item.name);assert.equal(manifest.version,item.version);
      const packed=await pack(item),metadata=await lookup(item,false);
      assert.ok(metadata,'immutable dependency missing; republish forbidden');
      assertArtifact(item,packed,metadata);await verifyPublished(item,packed,metadata,item.source);
    },
    manifest:async item=>JSON.parse(text(item.workspace+'/package.json')),pack,lookup,verifyPublished,
    publish:async(item,packed)=>{
      assertPacked(item,packed);
      const file=join(directory,packed.filename);
      assert.equal('sha512-'+createHash('sha512').update(readFileSync(file)).digest('base64'),item.integrity,
        'prepared artifact changed before publication');
      npm('publish',file,'--access','public','--tag','latest','--provenance','--json');
    },
  });
  console.log(JSON.stringify(result));
}

async function publicGet(value,json=true,timeout=30_000) {
  assert.equal(typeof json,'boolean','fixed registry response mode required');
  assert.ok(Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=30_000,'bounded registry timeout required');
  const url=registryUrl(value),response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(response.status===404){await response.body?.cancel();return null;}
  assert.ok(response.ok,'public registry HTTP '+response.status);
  const limit=json?8*1024*1024:32*1024*1024,chunks=[];let size=0;
  for await(const chunk of response.body??[]) {
    size+=chunk.byteLength;
    assert.ok(size<=limit&&chunks.length<4096,'public registry response too large');chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks,size);
  if(!json)return bytes;
  try{return JSON.parse(bytes.toString('utf8'));}
  catch{throw new Error('security_registry_json_invalid');}
}
export {publicGet as readSecurityRegistry};
