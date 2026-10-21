import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {securityRelease,securityPins,securityTextHash,securityWorkflowHash,assertSecuritySource,
  assertSecurityProvenance,publishSecurityRecovery,runSecurityCommand,readSecurityRegistry,securityNpmFailure} from './publish-security-recovery.mjs';

const head = 'a'.repeat(40);
const registry = 'https://registry.npmjs.org';
let cachedSnapshot;
function sourceSnapshot() {
  if(!cachedSnapshot) {
    const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root),'utf8');
    const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).trim();
    const baseline=path=>JSON.parse(git('show',securityRelease.baseline.commit+':'+path));
    const paths=git('ls-tree','-r','--name-only',securityRelease.baseline.commit,'packages').split('\n')
      .filter(path=>/^packages\/[^/]+\/package.json$/.test(path));
    const baselineManifest=baseline('package.json'),manifest=structuredClone(baselineManifest);
    manifest.scripts['pack:verify']=manifest.scripts['pack:verify'].replace('scripts/publish-signing-upgrade.test.mjs &&',
      'scripts/publish-signing-upgrade.test.mjs scripts/publish-security-recovery.test.mjs &&');
    manifest.scripts['publish:security-recovery']='node scripts/publish-security-recovery.mjs';
    manifest.scripts['test:security-recovery']='node --test scripts/publish-security-recovery.test.mjs';
    const publisherHash=securityTextHash(read('scripts/publish-security-recovery.mjs'));
    cachedSnapshot={head,remoteMain:head,ref:'refs/heads/main',repository:'dharma-ai-labs/dharma-agent-fabric',
      baselineTree:git('rev-parse',securityRelease.baseline.commit+'^{tree}'),dirty:'',untracked:[],
      changed:[...securityRelease.allowedPaths],publisherHash,expectedPublisherHash:publisherHash,
      manifestHash:securityTextHash(read('scripts/security-recovery-release.json')),
      workflowHash:securityWorkflowHash(read('.github/workflows/publish-security-recovery.yml')),
      testHash:securityTextHash(read('scripts/publish-security-recovery.test.mjs')),
      baselineManifest,manifest,baselineLock:git('show',securityRelease.baseline.commit+':package-lock.json'),
      lock:read('package-lock.json').trim(),baselinePackageManifests:Object.fromEntries(paths.map(path=>[path,baseline(path)])),
      packageManifests:Object.fromEntries(paths.map(path=>[path,baseline(path)]))};
  }
  return structuredClone(cachedSnapshot);
}

test('security source admission binds main, baseline, exact hashes, package manifests and root script delta',()=>{
  const snapshot=sourceSnapshot();assert.doesNotThrow(()=>assertSecuritySource(head,snapshot));
  for(const field of ['head','remoteMain','ref','repository','baselineTree','dirty','manifestHash','workflowHash',
    'testHash','publisherHash','expectedPublisherHash']){
    assert.throws(()=>assertSecuritySource(head,{...snapshot,[field]:'foreign'}),field);
  }
  assert.throws(()=>assertSecuritySource(head,{...snapshot,expectedPublisherHash:undefined}),/publisher pin/);
  for(const path of ['packages/cli/src/index.ts','packages/cli/package.json','package-lock.json',
    '.github/workflows/publish.yml','scripts/publish-signing-upgrade.mjs']){
    assert.throws(()=>assertSecuritySource(head,{...snapshot,changed:[...snapshot.changed,path]}),/source delta/);
  }
  assert.throws(()=>assertSecuritySource(head,{...snapshot,untracked:['private.env']}),/untracked/);
  const root=structuredClone(snapshot);root.manifest.scripts.build='true';
  assert.throws(()=>assertSecuritySource(head,root),/root manifest/);
  assert.throws(()=>assertSecuritySource(head,{...snapshot,lock:snapshot.lock+'foreign'}),/lock delta/);
  const packages=structuredClone(snapshot);packages.packageManifests['packages/cli/package.json'].version='0.0.0';
  assert.throws(()=>assertSecuritySource(head,packages),/package manifest/);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')),snapshot.manifest);
});

test('security publication workflow is explicit, main-only, protected, pinned and bound before installation',()=>{
  const workflow=parse(readFileSync(new URL('../.github/workflows/publish-security-recovery.yml',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_head.required,true);
  assert.deepEqual(workflow.permissions,{contents:'read','id-token':'write'});
  assert.equal(workflow.concurrency['cancel-in-progress'],false);
  const job=workflow.jobs.publish;
  assert.equal(job.if,"github.ref == 'refs/heads/main'");assert.equal(job.environment,'npm');
  assert.equal(job.env.SECURITY_PUBLISHER_SHA256,securityTextHash(readFileSync(new URL('./publish-security-recovery.mjs',import.meta.url),'utf8')));
  assert.equal(job.env.EXPECTED_HEAD,'${{ inputs.expected_head }}');
  assert.ok(job.steps.filter(step=>step.uses).every(step=>/@[a-f0-9]{40}$/.test(step.uses)));
  assert.equal(job.steps.find(step=>step.uses?.startsWith('actions/setup-node@')).with['node-version'],'22.22.3');
  const admission=job.steps.findIndex(step=>step.name==='Admit exact reviewed source before installing dependencies');
  assert.ok(admission>=0&&admission<job.steps.findIndex(step=>step.run==='npm ci'));
  assert.match(job.steps[admission].run,/sha256sum --check --status/);
  assert.match(job.steps[admission].run,/node scripts\/publish-security-recovery.mjs --expected-head "\$EXPECTED_HEAD" --admission-only/);
  const publisher=job.steps.find(step=>step.name==='Publish only the exact reviewed five-package cohort');
  assert.equal(publisher.env.NODE_AUTH_TOKEN,'${{ secrets.NPM_TOKEN }}');
  assert.match(publisher.run,/sha256sum --check --status/);
  assert.match(publisher.run,/npm run publish:security-recovery -- --expected-head "\$EXPECTED_HEAD" --publish/);
  assert.equal(job.steps.filter(step=>/--publish/.test(step.run??'')).length,1);
  assert.equal(job.steps.filter(step=>step.run==='npm run check').length,1);
  assert.equal(job.steps.filter(step=>step.run==='npm run test:security-recovery').length,0);
  assert.ok(job.steps.some(step=>step.run==='npm run publish:security-recovery -- --expected-head "$EXPECTED_HEAD"'));
  assert.ok(job.steps.every(step=>!step['continue-on-error']));
  for(const pin of Object.values(securityPins))assert.match(pin,/^[a-f0-9]{64}$/);
});

test('security provenance binds the dedicated main workflow, exact source, version and artifact subject',()=>{
  const repository='https://github.com/dharma-ai-labs/dharma-agent-fabric';
  const proof=statement=>({attestations:[{bundle:{dsseEnvelope:{payload:Buffer.from(JSON.stringify(statement)).toString('base64')}}}]});
  for(const item of securityRelease.cohort){
    const packed={integrity:item.integrity};
    const statement={predicateType:'https://slsa.dev/provenance/v1',predicate:{buildDefinition:{
      externalParameters:{workflow:{ref:'refs/heads/main',repository,path:'.github/workflows/publish-security-recovery.yml'}},
      resolvedDependencies:[{uri:'git+'+repository+'@refs/heads/main',digest:{gitCommit:head}}]}},
      subject:[{name:'pkg:npm/'+item.name.replace('@','%40')+'@'+item.version,
        digest:{sha512:Buffer.from(item.integrity.slice(7),'base64').toString('hex')}}]};
    assert.doesNotThrow(()=>assertSecurityProvenance(item,packed,proof(statement),head));
    for(const kind of ['workflow','ref','repository','source','subject','digest']){
      const changed=structuredClone(statement),definition=changed.predicate.buildDefinition;
      if(kind==='workflow')definition.externalParameters.workflow.path='.github/workflows/publish.yml';
      if(kind==='ref')definition.externalParameters.workflow.ref='refs/tags/v0.2.212';
      if(kind==='repository')definition.externalParameters.workflow.repository='https://github.com/foreign/repo';
      if(kind==='source')definition.resolvedDependencies[0].digest.gitCommit='b'.repeat(40);
      if(kind==='subject')changed.subject[0].name='pkg:npm/foreign@1.0.0';
      if(kind==='digest')changed.subject[0].digest.sha512='foreign';
      assert.throws(()=>assertSecurityProvenance(item,packed,proof(changed),head),kind);
    }
    assert.throws(()=>assertSecurityProvenance({...item,version:'0.0.0'},packed,proof(statement),head));
  }
  assert.throws(()=>assertSecurityProvenance(securityRelease.unchangedDependencies[0],{}, {},head),/unreviewed security package/);
});

test('security registry reads are public-only, no-redirect, bounded and do not reflect invalid bodies',async t=>{
  let calls=0,response;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);return response;
  });
  for(const url of ['https://foreign.invalid/file','https://registry.npmjs.org/?token=CANARY_PRIVATE',
    'https://user:CANARY_PRIVATE@registry.npmjs.org/file']){
    await assert.rejects(readSecurityRegistry(url),error=>{
      assert.doesNotMatch(String(error),/CANARY_PRIVATE/);return true;
    });
  }
  for(const timeout of [0,-1,Infinity,30_001,1.5])await assert.rejects(readSecurityRegistry(registry,true,timeout));
  await assert.rejects(readSecurityRegistry(registry,'false'));
  assert.equal(calls,0);
  response=new Response('{"ok":true}');assert.deepEqual(await readSecurityRegistry(registry),{ok:true});
  response=new Response(new Uint8Array([1,2,3]));assert.deepEqual(await readSecurityRegistry(registry,false),Buffer.from([1,2,3]));
  let cancelled=false;
  response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:404});
  assert.equal(await readSecurityRegistry(registry),null);assert.equal(cancelled,true);
  response=new Response('CANARY_PRIVATE_NOT_JSON');
  await assert.rejects(readSecurityRegistry(registry),error=>{
    assert.match(String(error),/registry_json_invalid/);assert.doesNotMatch(String(error),/CANARY_PRIVATE/);return true;
  });
});

test('security registry byte and chunk limits cancel oversized streams before parsing',async t=>{
  let response;
  t.mock.method(globalThis,'fetch',async()=>response);
  for(const mode of ['bytes','chunks']){
    let cancelled=false,pulls=0;
    const chunk=new Uint8Array(mode==='bytes'?4*1024*1024:1);
    response=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(chunk);},
      cancel(){cancelled=true;}}));
    await assert.rejects(readSecurityRegistry(registry,mode==='bytes'),/registry response too large/);
    assert.equal(cancelled,true);assert.ok(pulls<=(mode==='bytes'?5:4100));
  }
});
function fixture() {
  const events = [], visible = new Set();
  const packed = item => ({name:item.name, version:item.version, integrity:item.integrity,
    filename:item.name.slice(1).replace('/','-')+'-'+item.version+'.tgz'});
  const metadata = item => ({name:item.name, version:item.version, dist:{integrity:item.integrity,
    tarball:registry+'/'+item.name+'/-/'+item.name.split('/')[1]+'-'+item.version+'.tgz',
    attestations:{url:registry+'/-/npm/v1/attestations/fixture'}}});
  const io = {
    verifySource: async value => {assert.equal(value,head);events.push('source');},
    verifyImmutable: async item => {events.push('immutable:'+item.name);},
    manifest: async item => ({name:item.name,version:item.version}),
    pack: async item => {events.push('pack:'+item.name);return packed(item);},
    lookup: async item => visible.has(item.name)?metadata(item):null,
    verifyPublished: async (item,_pack,_metadata,source) => {assert.equal(source,head);events.push('verified:'+item.name);},
    publish: async item => {events.push('publish:'+item.name);visible.add(item.name);},
  };
  return {io,events,visible,packed,metadata};
}

test('security release is only the exact five-package dependency closure with CLI last', () => {
  assert.deepEqual(securityRelease.cohort.map(item=>[item.workspace,item.version]),[
    ['packages/provider-adapters','0.1.37'],['packages/evidence-reduction','0.2.36'],
    ['packages/task-runner','0.1.39'],['packages/local-vault','0.1.33'],['packages/cli','0.2.212'],
  ]);
  assert.equal(securityRelease.unchangedDependencies.length,6);
  for(const item of [...securityRelease.cohort,...securityRelease.unchangedDependencies])assert.match(item.integrity,/^sha512-/);
});

test('default security plan validates all artifacts but performs no publication', async () => {
  const {io,events}=fixture();
  const result=await publishSecurityRecovery(head,io);
  assert.equal(result.state,'ready_not_published');assert.equal(result.writes,0);
  assert.equal(events.filter(e=>e.startsWith('immutable:')).length,6);
  assert.equal(events.filter(e=>e.startsWith('pack:')).length,5);
  assert.equal(events.some(e=>e.startsWith('publish:')),false);
});

test('security release rejects malformed heads or non-boolean write modes before source access',async()=>{
  for(const value of ['', 'main', 'b'.repeat(39), 'C'.repeat(40)]){
    const {io,events}=fixture();await assert.rejects(publishSecurityRecovery(value,io));assert.deepEqual(events,[]);
  }
  for(const publish of [1, 'true', null]){
    const {io,events}=fixture();await assert.rejects(publishSecurityRecovery(head,io,{publish}));assert.deepEqual(events,[]);
  }
});

test('security package and historical artifact declarations cannot be mutated by a caller',()=>{
  assert.throws(()=>{securityRelease.cohort[0].name='foreign';},TypeError);
  assert.throws(()=>{securityRelease.unchangedDependencies.length=0;},TypeError);
  const preserved=securityRelease.unchangedDependencies.find(item=>item.preserveOriginal);
  assert.throws(()=>{preserved.preserveOriginal.sourceChanges.push('foreign');},TypeError);
});

test('explicit security publication qualifies every artifact first and keeps the exact dependency order', async () => {
  const {io,events}=fixture();
  const result=await publishSecurityRecovery(head,io,{publish:true});
  assert.equal(result.state,'published_verified');assert.equal(result.writes,5);
  const writes=events.filter(e=>e.startsWith('publish:'));
  assert.deepEqual(writes,securityRelease.cohort.map(item=>'publish:'+item.name));
  const first=events.indexOf(writes[0]);
  assert.equal(events.slice(0,first).filter(e=>e.startsWith('pack:')).length,5);
  assert.equal(events.slice(0,first).filter(e=>e.startsWith('immutable:')).length,6);
});

for(const kind of ['immutable','manifest','version','integrity','filename','tarball','attestation','provenance']) {
  test('security preflight '+kind+' failure prevents all publication',async()=>{
    const {io,events,visible}=fixture();
    if(kind==='immutable')io.verifyImmutable=async()=>{throw Error('immutable mismatch');};
    if(kind==='manifest'||kind==='version'){
      const manifest=io.manifest;io.manifest=async item=>({...await manifest(item),[kind==='manifest'?'name':'version']:'foreign'});
    }
    if(kind==='integrity'||kind==='filename'){
      const pack=io.pack;io.pack=async item=>({...await pack(item),[kind]:'foreign'});
    }
    if(kind==='tarball'||kind==='attestation'||kind==='provenance'){
      for(const item of securityRelease.cohort)visible.add(item.name);
      if(kind==='provenance')io.verifyPublished=async()=>{throw Error('provenance mismatch');};
      else {const lookup=io.lookup;io.lookup=async item=>{
        const value=await lookup(item);
        if(kind==='tarball')value.dist.tarball='https://foreign.invalid/file.tgz';
        else value.dist.attestations.url='https://foreign.invalid/proof';
        return value;
      };}
    }
    await assert.rejects(publishSecurityRecovery(head,io,{publish:true}));
    assert.equal(events.some(e=>e.startsWith('publish:')),false);
  });
}

test('moved main before a security write prevents that write, including after partial publication',async()=>{
  for(const stopAt of [2,3]){
    const {io,events}=fixture();let calls=0;
    io.verifySource=async()=>{if(++calls===stopAt)throw Error('main moved');};
    await assert.rejects(publishSecurityRecovery(head,io,{publish:true}),/main moved/);
    assert.equal(events.filter(e=>e.startsWith('publish:')).length,stopAt-2);
  }
});

test('uncertain security publication stops with one write and never retries',async()=>{
  const {io,events}=fixture(),lookup=io.lookup;
  io.lookup=async(item,published)=>published?null:lookup(item);
  await assert.rejects(publishSecurityRecovery(head,io,{publish:true}),/unconfirmed/);
  assert.deepEqual(events.filter(e=>e.startsWith('publish:')),['publish:'+securityRelease.cohort[0].name]);
});

test('security provenance failure after a write prevents every subsequent package',async()=>{
  const {io,events}=fixture();io.verifyPublished=async()=>{throw Error('provenance_unconfirmed');};
  await assert.rejects(publishSecurityRecovery(head,io,{publish:true}),/provenance_unconfirmed/);
  assert.deepEqual(events.filter(e=>e.startsWith('publish:')),['publish:'+securityRelease.cohort[0].name]);
});

test('already visible exact security cohort requires provenance and is never republished',async()=>{
  const {io,events,visible}=fixture();for(const item of securityRelease.cohort)visible.add(item.name);
  const result=await publishSecurityRecovery(head,io,{publish:true});
  assert.equal(result.writes,0);assert.equal(events.some(e=>e.startsWith('publish:')),false);
  assert.equal(events.filter(e=>e.startsWith('verified:')).length,5);
});

test('security command accepts only fixed plan, admission and explicit publication options',async()=>{
  for(const args of [[],['--expected-head','bad'],['--expected-head',head,'--force'],
    ['--expected-head',head,'--publish','--publish']]){
    const {io,events}=fixture();await assert.rejects(runSecurityCommand(args,io));assert.deepEqual(events,[]);
  }
  const {io,events}=fixture();
  assert.equal((await runSecurityCommand(['--expected-head',head,'--admission-only'],io)).state,'source_admitted');
  assert.deepEqual(events,['source']);
});

test('unconfigured security CLI fails closed without successful output',()=>{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./publish-security-recovery.mjs',import.meta.url)),
    '--expected-head',head,'--publish'],{encoding:'utf8',timeout:10_000,
    env:{...process.env,SECURITY_PUBLISHER_SHA256:''}});
  assert.equal(child.status,1);assert.equal(child.stdout,'');
  assert.match(child.stderr,/security_release_source_admission_not_qualified/);
});

test('npm failure diagnostics expose only fixed phases and known structured error codes',()=>{
  for(const code of ['E401','E403','EINTEGRITY','EPUBLISHCONFLICT']){
    const error=securityNpmFailure('publish',{stdout:JSON.stringify({error:{code,summary:'CANARY_PRIVATE'}}),
      stderr:'CANARY_PRIVATE',message:'CANARY_PRIVATE'});
    assert.equal(error.message,'security_npm_publish_failed_reconcile:'+code);
    assert.doesNotMatch(String(error),/CANARY_PRIVATE/);
  }
  for(const stdout of ['CANARY_PRIVATE',JSON.stringify({error:{code:'CANARY_PRIVATE',detail:'CANARY_PRIVATE'}})]){
    assert.equal(securityNpmFailure('pack',{stdout}).message,'security_npm_pack_failed_reconcile:UNCLASSIFIED');
  }
  assert.throws(()=>securityNpmFailure('foreign',{}),/fixed npm phase/);
});
