import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {parse} from 'yaml';
import {release,textHash,normalizedWorkflowHash,assertSigningSource,publishSigningUpgrade,runSigningCommand,assertReleaseProvenance} from './publish-signing-upgrade.mjs';

const head='a'.repeat(40),digest='sha512-'+Buffer.alloc(64,7).toString('base64');
const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
function snapshot(){
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8388608}).trim();
  const baseline=p=>JSON.parse(git('show',release.baseline.commit+':'+p));
  return{head,remoteMain:head,ref:'refs/heads/main',baselineTree:release.baseline.tree,dirty:'',untracked:[],changed:release.allowedPaths,
    manifestHash:textHash(read('scripts/signing-upgrade-release.json')),
    publisherHash:textHash(read('scripts/publish-signing-upgrade.mjs')),expectedPublisherHash:textHash(read('scripts/publish-signing-upgrade.mjs')),
    workflowHash:normalizedWorkflowHash(read('.github/workflows/publish-signing-upgrade.yml')),
    testHash:textHash(read('scripts/publish-signing-upgrade.test.mjs')),
    productHashes:Object.fromEntries(Object.keys(release.productHashes).map(p=>[p,textHash(read(p))])),
    baselineManifest:baseline('package.json'),manifest:JSON.parse(read('package.json')),
    baselineCliManifest:baseline('packages/cli/package.json'),cliManifest:JSON.parse(read('packages/cli/package.json')),
    baselineLock:baseline('package-lock.json'),lock:JSON.parse(read('package-lock.json'))};
}

function fixture(){
  const events=[],visible=new Set(release.dependencies.map(i=>i.name));
  const packed=i=>({name:i.name,version:i.version,integrity:i.integrity??digest,
    filename:i.name.slice(1).replace('/','-')+'-'+i.version+'.tgz'});
  const metadata=i=>({name:i.name,version:i.version,dist:{integrity:packed(i).integrity,
    tarball:`https://registry.npmjs.org/${i.name}/-/${i.name.split('/').at(-1)}-${i.version}.tgz`,
    attestations:{url:'https://registry.npmjs.org/-/npm/v1/attestations/fixture'}}});
  const io={verifySource:async h=>{assert.equal(h,head);events.push('source');},
    pack:async i=>{events.push('pack:'+i.name);return packed(i);},
    lookup:async i=>visible.has(i.name)?metadata(i):null,
    publish:async i=>{events.push('publish:'+i.name);visible.add(i.name);},
    verifyPublished:async(i,_p,_m,source)=>{assert.equal(source,i.source??head);events.push('verified:'+i.name);}};
  return{io,events,visible,packed,metadata};
}

test('reviewed release changes only CLI211 and retains ten exact immutable dependencies',()=>{
  assert.equal(release.cli.name,'@dharma-ai-labs/agent-fabric');assert.equal(release.cli.version,'0.2.211');
  assert.equal(release.dependencies.length,10);assert.equal(new Set(release.dependencies.map(i=>i.name)).size,10);
  for(const item of release.dependencies){assert.match(item.source,/^[a-f0-9]{40}$/);assert.match(item.integrity,/^sha512-/);}
  assert.doesNotThrow(()=>assertSigningSource(head,snapshot()));
});

test('source admission rejects changed main, policy, publisher, product, lock and workflow bytes',()=>{
  const s=snapshot();
  for(const field of ['head','remoteMain','ref','baselineTree','dirty','manifestHash','publisherHash','workflowHash','testHash']){
    assert.throws(()=>assertSigningSource(head,{...s,[field]:'foreign'}),field);
  }
  assert.throws(()=>assertSigningSource(head,{...s,expectedPublisherHash:undefined}));
  assert.throws(()=>assertSigningSource(head,{...s,changed:[...s.changed,'packages/secure-store/src/index.ts']}));
  assert.throws(()=>assertSigningSource(head,{...s,untracked:['private.env']}));
  for(const field of ['manifest','cliManifest','lock','productHashes']){
    const changed=structuredClone(s);changed[field].unreviewed=true;assert.throws(()=>assertSigningSource(head,changed),field);
  }
});

test('new workflow is explicit main-only, independent, pinned and CLI-only',()=>{
  const w=parse(read('.github/workflows/publish-signing-upgrade.yml')),job=w.jobs.publish;
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.equal(w.on.workflow_dispatch.inputs.expected_head.required,true);
  assert.equal(job.if,"github.ref == 'refs/heads/main'");assert.equal(job.environment,'npm');
  assert.equal(job.env.SIGNING_PUBLISHER_SHA256,textHash(read('scripts/publish-signing-upgrade.mjs')));
  assert.equal(Object.keys(w.jobs).length,1);assert.equal(job.steps.find(s=>s.name==='Publish only the reviewed CLI patch').env.NODE_AUTH_TOKEN,'${{ secrets.NPM_TOKEN }}');
  for(const name of ['Admit exact reviewed source before installing dependencies','Publish only the reviewed CLI patch']){
    const step=job.steps.find(s=>s.name===name);assert.match(step.run,/sha256sum --check --status/);
    const command=name.startsWith('Admit')?'node scripts/publish-signing-upgrade.mjs':'npm run publish:signing-upgrade';
    assert.ok(step.run.indexOf('sha256sum')<step.run.indexOf(command));
  }
  assert.ok(job.steps.findIndex(s=>s.name==='Admit exact reviewed source before installing dependencies')<job.steps.findIndex(s=>s.run==='npm ci'));
});

test('default plan verifies all eleven artifacts but performs no publication',async()=>{
  const {io,events}=fixture();const r=await publishSigningUpgrade(head,io);
  assert.equal(r.state,'ready_not_published');assert.equal(r.writes,0);
  assert.equal(events.filter(e=>e.startsWith('pack:')).length,11);assert(!events.some(e=>e.startsWith('publish:')));
});

test('explicit publication performs exactly one CLI write after all dependencies and current main checks',async()=>{
  const {io,events}=fixture();const r=await publishSigningUpgrade(head,io,{publish:true});
  assert.equal(r.state,'published_verified');assert.equal(r.writes,1);
  assert.deepEqual(events.filter(e=>e.startsWith('publish:')),['publish:'+release.cli.name]);
  assert.equal(events.slice(0,events.indexOf('publish:'+release.cli.name)).filter(e=>e.startsWith('pack:')).length,11);
  assert.equal(events.filter(e=>e==='source').length,2);
});

for(const kind of ['missing-dependency','changed-dependency','foreign-tarball','foreign-attestation','wrong-name','wrong-version']){
  test(kind+' refuses before the sole publication',async()=>{
    const {io,events}=fixture(),lookup=io.lookup,pack=io.pack;
    if(kind==='missing-dependency')io.lookup=async()=>null;
    if(kind==='changed-dependency')io.pack=async i=>({...await pack(i),integrity:digest});
    if(kind.startsWith('foreign-')||kind.startsWith('wrong-'))io.lookup=async i=>{const m=await lookup(i);if(!m)return m;
      if(kind==='foreign-tarball')m.dist.tarball='https://foreign.invalid/a.tgz';
      if(kind==='foreign-attestation')m.dist.attestations.url='https://foreign.invalid/proof';
      if(kind==='wrong-name')m.name='foreign';if(kind==='wrong-version')m.version='0.0.0';return m;};
    await assert.rejects(publishSigningUpgrade(head,io,{publish:true}));assert(!events.some(e=>e.startsWith('publish:')));
  });
}

test('moved main during qualification prevents publication',async()=>{
  const {io,events}=fixture();let n=0;io.verifySource=async()=>{if(++n>1)throw Error('main moved');};
  await assert.rejects(publishSigningUpgrade(head,io,{publish:true}),/main moved/);assert(!events.some(e=>e.startsWith('publish:')));
});

test('uncertain publication stops with one write and no blind replay',async()=>{
  const {io,events}=fixture(),lookup=io.lookup;io.lookup=async(i,published)=>published?null:lookup(i);
  await assert.rejects(publishSigningUpgrade(head,io,{publish:true}),/unconfirmed/);
  assert.deepEqual(events.filter(e=>e.startsWith('publish:')),['publish:'+release.cli.name]);
});

test('already visible matching CLI requires provenance and is never republished',async()=>{
  const {io,events,visible}=fixture();visible.add(release.cli.name);
  assert.equal((await publishSigningUpgrade(head,io,{publish:true})).state,'already_published_verified');assert(!events.some(e=>e.startsWith('publish:')));
});

test('fixed parser rejects extra and duplicate options without source or publication effects',async()=>{
  for(const args of [[],['--expected-head','bad'],['--expected-head',head,'--force'],['--expected-head',head,'--publish','--publish']]){
    const {io,events}=fixture();await assert.rejects(runSigningCommand(args,io));assert.deepEqual(events,[]);
  }
  const {io,events}=fixture();assert.equal((await runSigningCommand(['--expected-head',head,'--admission-only'],io)).state,'source_admitted');assert.deepEqual(events,['source']);
});

test('CLI provenance binds the new official main workflow, source and artifact subject',()=>{
  const item=release.cli,packed={integrity:digest};
  const statement={predicateType:'https://slsa.dev/provenance/v1',predicate:{buildDefinition:{
    externalParameters:{workflow:{ref:'refs/heads/main',repository:'https://github.com/dharma-ai-labs/dharma-agent-fabric',path:'.github/workflows/publish-signing-upgrade.yml'}},
    resolvedDependencies:[{uri:'git+https://github.com/dharma-ai-labs/dharma-agent-fabric@refs/heads/main',digest:{gitCommit:head}}]}},
    subject:[{name:`pkg:npm/%40dharma-ai-labs/agent-fabric@${item.version}`,digest:{sha512:Buffer.from(digest.slice(7),'base64').toString('hex')}}]};
  const proof=s=>({attestations:[{bundle:{dsseEnvelope:{payload:Buffer.from(JSON.stringify(s)).toString('base64')}}}]});
  assert.doesNotThrow(()=>assertReleaseProvenance(item,packed,proof(statement),head));
  for(const field of ['path','ref','repository']){const changed=structuredClone(statement);changed.predicate.buildDefinition.externalParameters.workflow[field]='foreign';
    assert.throws(()=>assertReleaseProvenance(item,packed,proof(changed),head));}
  assert.throws(()=>assertReleaseProvenance(item,packed,proof(statement),'b'.repeat(40)));
  const changed=structuredClone(statement);changed.subject[0].digest.sha512='foreign';assert.throws(()=>assertReleaseProvenance(item,packed,proof(changed),head));
});

test('Linux canonical packs retain all ten immutable dependency SRIs', {skip:process.platform!=='linux'},()=>{
  assert.ok(process.env.npm_execpath,'normal npm test context required');
  const directory=mkdtempSync(join(tmpdir(),'dharma-signing-dependency-packs-'));
  try{
    const globalConfig=join(directory,'public-global.npmrc');writeFileSync(globalConfig,'',{mode:0o600,flag:'wx'});
    for(const item of release.dependencies){
      const packed=JSON.parse(execFileSync(process.execPath,[process.env.npm_execpath,'pack','--workspace',item.workspace,
        '--json','--pack-destination',directory],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8388608,
        stdio:['ignore','pipe','pipe'],env:{...process.env,HOME:directory,XDG_CONFIG_HOME:directory,
          npm_config_userconfig:'/dev/null',npm_config_globalconfig:globalConfig,
          npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false'}}))[0];
      assert.equal(packed.name,item.name);assert.equal(packed.version,item.version);
      assert.equal(packed.integrity,item.integrity,'immutable package changed: '+item.name);
      assert.equal('sha512-'+createHash('sha512').update(readFileSync(join(directory,packed.filename))).digest('base64'),item.integrity);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
