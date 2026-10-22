import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';

const load=()=>import('./publish-device-maintenance.mjs');
const head='a'.repeat(40),digest='sha512-'+Buffer.alloc(64,7).toString('base64');
const hash=value=>createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');

test('device maintenance tests have an explicit normal npm execution entry point',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.scripts['test:device-maintenance'],'node --test scripts/publish-device-maintenance.test.mjs');
});

async function snapshot(){
  const m=await load(),root=new URL('../',import.meta.url);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).trim();
  const baseline=m.maintenanceBaseline.commit,manifest=JSON.parse(git('show',baseline+':package.json'));
  manifest.scripts['publish:device-maintenance']='node scripts/publish-device-maintenance.mjs';
  manifest.scripts['pack:verify']=manifest.scripts['pack:verify'].replace('scripts/publish-recovery-contracts.test.mjs',
    'scripts/publish-recovery-contracts.test.mjs scripts/publish-device-maintenance.test.mjs');
  const paths=git('ls-tree','-r','--name-only',baseline,'packages').split('\n').filter(p=>/^packages\/[^/]+\/package.json$/.test(p));
  const manifests=Object.fromEntries(paths.map(p=>[p,JSON.parse(git('show',baseline+':'+p))]));
  return {head,remoteMain:head,ref:'refs/heads/main',baselineTree:git('rev-parse',baseline+'^{tree}'),dirty:'',untracked:[],
    changed:['scripts/publish-device-maintenance.mjs','scripts/publish-device-maintenance.test.mjs','package.json',
      '.github/workflows/publish.yml','scripts/publish-workflow.test.mjs'],
    baselineManifest:JSON.parse(git('show',baseline+':package.json')),manifest,
    baselineLock:git('show',baseline+':package-lock.json'),lock:git('show',baseline+':package-lock.json'),
    baselineManifests:manifests,manifests:structuredClone(manifests),
    workflowHash:m.maintenanceWorkflowHash(git('show','73793c2df81f6bf9c81fe276b37997fa2159c67d:.github/workflows/publish.yml')+'\n'),
    expectedPublisherHash:hash(readFileSync(new URL('./publish-device-maintenance.mjs',import.meta.url),'utf8')),
    publisherHash:hash(readFileSync(new URL('./publish-device-maintenance.mjs',import.meta.url),'utf8')),
    workflowTestHash:hash(git('show','73793c2df81f6bf9c81fe276b37997fa2159c67d:scripts/publish-workflow.test.mjs')+'\n'),
    releaseTestHash:hash(git('show','73793c2df81f6bf9c81fe276b37997fa2159c67d:scripts/publish-device-maintenance.test.mjs')+'\n')};
}
async function fixture(){
  const m=await load(),events=[],existing=new Set(m.maintenancePackages.filter(x=>x.existingArtifact).map(x=>x.name));
  const packed=item=>({name:item.name,version:item.version,filename:item.name.slice(1).replace('/','-')+'-'+item.version+'.tgz',
    integrity:item.existingArtifact?.integrity??digest});
  const metadata=item=>({name:item.name,version:item.version,dist:{integrity:packed(item).integrity,
    tarball:'https://registry.npmjs.org/'+item.name+'/-/'+item.name.split('/')[1]+'-'+item.version+'.tgz',
    attestations:{url:'https://registry.npmjs.org/-/npm/v1/attestations/fixture'}}});
  const io={verifySource:async value=>{assert.equal(value,head);events.push('source');},manifest:async item=>({name:item.name,version:item.version}),
    pack:async item=>{events.push('pack:'+item.name);return packed(item);},
    lookup:async item=>existing.has(item.name)?metadata(item):null,
    publish:async item=>{events.push('publish:'+item.name);existing.add(item.name);},
    verifyPublished:async(item,_packed,_metadata,source)=>{assert.equal(source,item.existingArtifact?.source??head);events.push('verified:'+item.name);}};
  return {m,io,events,existing,packed,metadata};
}

test('separate compatible maintenance cohort publishes only contracts018 relay034 vault032 then CLI210',async()=>{
  const m=await load();assert.deepEqual(m.maintenancePackages.filter(x=>!x.existingArtifact).map(x=>[x.workspace,x.version]),[
    ['packages/contracts','0.1.18'],['packages/relay-client','0.2.34'],['packages/local-vault','0.1.32'],['packages/cli','0.2.210']]);
  assert.deepEqual(m.maintenancePackages.filter(x=>x.existingArtifact).map(x=>x.version),['0.1.36','0.1.38','0.2.35','0.1.10']);
});
test('exact qualified source admits only the fixed normal-main publisher delta',async()=>{
  const m=await load(),s=await snapshot();assert.doesNotThrow(()=>m.assertMaintenanceSource(head,s));
  for(const field of ['head','remoteMain','ref','baselineTree','dirty','workflowHash','workflowTestHash','releaseTestHash']){
    assert.throws(()=>m.assertMaintenanceSource(head,{...s,[field]:'foreign'}));
  }
  for(const path of ['packages/cli/src/index.ts','packages/cli/package.json','package-lock.json','scripts/publish-onboarding-release.mjs','src/unreviewed.ts']){
    assert.throws(()=>m.assertMaintenanceSource(head,{...s,changed:[...s.changed,path]}),/unreviewed/);
  }
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,untracked:['private.env']}),/untracked/);
  const foreign=structuredClone(s);foreign.manifest.scripts.test='true';assert.throws(()=>m.assertMaintenanceSource(head,foreign));
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,lock:s.lock+'\nforeign'}));
  const altered=structuredClone(s);altered.manifests['packages/cli/package.json'].dependencies={};
  assert.throws(()=>m.assertMaintenanceSource(head,altered));
});

test('historical CLI210 admission refuses current runtime manifests and changed release-test bytes',async()=>{
  const m=await load(),s=await snapshot(),root=new URL('../',import.meta.url);
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,
    releaseTestHash:hash(readFileSync(import.meta.filename,'utf8'))}),/release tests/);
  const current=Object.fromEntries(Object.keys(s.manifests).map(path=>
    [path,JSON.parse(readFileSync(new URL(path,root),'utf8'))]));
  assert.notDeepEqual(current,s.baselineManifests);
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,manifests:current}),/package manifest/);
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,
    workflowHash:m.maintenanceWorkflowHash(readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8'))}),/publisher workflow/);
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,
    workflowTestHash:hash(readFileSync(new URL('./publish-workflow.test.mjs',import.meta.url),'utf8'))}),/workflow tests/);
});
test('admission binds executed publisher bytes to the independently pinned workflow value',async()=>{
  const m=await load(),s=await snapshot();
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,publisherHash:'b'.repeat(64)}),/publisher/);
  assert.throws(()=>m.assertMaintenanceSource(head,{...s,expectedPublisherHash:undefined}),/publisher/);
});
test('current main is read through the exact remote ref rather than a cached tracking branch',async()=>{
  const m=await load(),calls=[];
  assert.equal(m.readMaintenanceRemoteMain((...args)=>{calls.push(args);return head+'\trefs/heads/main';}),head);
  assert.deepEqual(calls,[['ls-remote','--exit-code','origin','refs/heads/main']]);
  for(const response of [head+'\trefs/heads/other','',head+'\trefs/heads/main\n'+head+'\trefs/heads/other']){
    assert.throws(()=>m.readMaintenanceRemoteMain(()=>response),/remote main/);
  }
});
test('default plan validates every package and never publishes',async()=>{
  const {m,io,events}=await fixture();const r=await m.publishDeviceMaintenance(head,io);
  assert.equal(r.state,'ready_not_published');assert.equal(events.filter(x=>x.startsWith('pack:')).length,8);
  assert.equal(events.some(x=>x.startsWith('publish:')),false);
});
test('a local scope-prefixed pack filename is not an official registry tarball basename',async()=>{
  const {m,io,events,packed}=await fixture(),lookup=io.lookup;
  io.lookup=async item=>{const record=await lookup(item);if(record){
    record.dist.tarball='https://registry.npmjs.org/'+item.name+'/-/'+packed(item).filename;
  }return record;};
  await assert.rejects(m.publishDeviceMaintenance(head,io),/registry tarball mismatch/);
  assert.equal(events.some(x=>x.startsWith('publish:')),false);
});
test('explicit publication validates the entire cohort before the first write and keeps CLI last',async()=>{
  const {m,io,events}=await fixture();const r=await m.publishDeviceMaintenance(head,io,{publish:true});
  const writes=events.filter(x=>x.startsWith('publish:'));assert.equal(r.state,'published_verified');
  assert.deepEqual(writes,['publish:@dharma-ai-labs/agent-fabric-contracts','publish:@dharma-ai-labs/agent-fabric-relay-client',
    'publish:@dharma-ai-labs/agent-fabric-local-vault','publish:@dharma-ai-labs/agent-fabric']);
  assert.equal(events.slice(0,events.indexOf(writes[0])).filter(x=>x.startsWith('pack:')).length,8);
});
test('moved main during packing prevents the first publication',async()=>{
  const {m,io,events}=await fixture();let checks=0;
  io.verifySource=async()=>{if(++checks>1)throw Error('remote main moved');};
  await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/remote main moved/);
  assert.equal(checks,2);assert.equal(events.some(x=>x.startsWith('publish:')),false);
});
test('moved main after a partial publication stops before the next package',async()=>{
  const {m,io,events}=await fixture();let checks=0;
  io.verifySource=async()=>{if(++checks>2)throw Error('remote main moved');};
  await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/remote main moved/);
  assert.equal(checks,3);assert.deepEqual(events.filter(x=>x.startsWith('publish:')),['publish:@dharma-ai-labs/agent-fabric-contracts']);
});
for(const kind of ['missing-immutable','changed-immutable','wrong-name','wrong-version','bad-integrity','bad-filename','foreign-tarball','foreign-attestation']){
  test('preflight '+kind+' prevents every publication',async()=>{
    const {m,io,events}=await fixture(),pack=io.pack,lookup=io.lookup,manifest=io.manifest;
    if(kind==='missing-immutable')io.lookup=async item=>item.existingArtifact?null:lookup(item);
    if(kind==='changed-immutable')io.pack=async item=>({...await pack(item),integrity:digest});
    if(kind==='wrong-name'||kind==='wrong-version')io.manifest=async item=>({...await manifest(item),[kind==='wrong-name'?'name':'version']:'foreign'});
    if(kind==='bad-integrity'||kind==='bad-filename')io.pack=async item=>({...await pack(item),[kind==='bad-integrity'?'integrity':'filename']:'foreign'});
    if(kind==='foreign-tarball'||kind==='foreign-attestation')io.lookup=async item=>{const r=await lookup(item);if(r){
      if(kind==='foreign-tarball')r.dist.tarball='https://foreign.invalid/source.tgz';else r.dist.attestations.url='https://foreign.invalid/proof';}return r;};
    await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}));assert.equal(events.some(x=>x.startsWith('publish:')),false);
  });
}
test('partial publication stops on uncertain visibility and cannot advance or republish automatically',async()=>{
  const {m,io,events}=await fixture(),lookup=io.lookup;
  io.lookup=async(item,published)=>published?null:lookup(item);
  await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/unconfirmed/);
  assert.deepEqual(events.filter(x=>x.startsWith('publish:')),['publish:@dharma-ai-labs/agent-fabric-contracts']);
});
test('already visible compatible packages require exact provenance and are never republished',async()=>{
  const {m,io,events,existing}=await fixture();for(const item of m.maintenancePackages)existing.add(item.name);
  await m.publishDeviceMaintenance(head,io,{publish:true});assert.equal(events.some(x=>x.startsWith('publish:')),false);
  assert.equal(events.filter(x=>x.startsWith('verified:')).length,8);
});
test('required provenance failure never advances to later packages',async()=>{
  const {m,io,events}=await fixture(),verify=io.verifyPublished;
  io.verifyPublished=async(item,...args)=>{if(!item.existingArtifact)throw Error('provenance_unconfirmed');return verify(item,...args);};
  await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/provenance_unconfirmed/);
  assert.deepEqual(events.filter(x=>x.startsWith('publish:')),['publish:@dharma-ai-labs/agent-fabric-contracts']);
});
test('fixed command parser refuses extra flags and defaults to no publication',async()=>{
  for(const args of [[],['--expected-head','bad'],['--expected-head',head,'--force'],['--expected-head',head,'--publish','--publish']]){
    const {m,io,events}=await fixture();await assert.rejects(m.runMaintenanceCommand(args,io));assert.deepEqual(events,[]);
  }
  const {m,io,events}=await fixture();assert.equal((await m.runMaintenanceCommand(['--expected-head',head,'--admission-only'],io)).state,'source_admitted');
  assert.deepEqual(events,['source']);
});
test('Linux canonical packs keep historical artifacts immutable and reject replacement source before publication',
  {skip:process.platform!=='linux'},async()=>{
    const m=await load(),root=new URL('../',import.meta.url),directory=mkdtempSync(join(tmpdir(),'dharma-maintenance-pack-'));
    assert.ok(process.env.npm_execpath,'normal npm test context required');
    try{
      for(const item of m.maintenancePackages.filter(item=>item.existingArtifact)){
        const packed=JSON.parse(execFileSync(process.execPath,[process.env.npm_execpath,'pack','--workspace',item.workspace,
          '--json','--pack-destination',directory],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
          stdio:['ignore','pipe','pipe'],env:{...process.env,npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false'}}))[0];
        const current=JSON.parse(readFileSync(new URL(item.workspace+'/package.json',root),'utf8'));
        assert.equal(packed.name,item.name);assert.equal(packed.version,current.version);
        assert.equal('sha512-'+createHash('sha512').update(readFileSync(join(directory,packed.filename))).digest('base64'),packed.integrity);
        if(item.name==='@dharma-ai-labs/agent-fabric-secure-store'&&current.version===item.version
          &&packed.integrity!==item.existingArtifact.integrity){
          assert.notEqual(packed.integrity,item.existingArtifact.integrity);
          const changed=execFileSync('git',['diff','--name-only',item.existingArtifact.source,'HEAD','--',item.workspace],
            {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n').filter(Boolean);
          assert.deepEqual(changed,['packages/secure-store/src/index.test.ts',
            'packages/secure-store/src/windowsEnrollmentAnchor.test.ts']);
          const {io,events,packed:originalPack}=await fixture();
          io.pack=async candidate=>candidate.name===item.name?packed:originalPack(candidate);
          await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/immutable artifact changed/);
          assert.equal(events.some(event=>event.startsWith('publish:')),false);
        }else if(current.version===item.version){
          assert.equal(packed.integrity,item.existingArtifact.integrity,'immutable package bytes changed: '+item.name);
        }else{
          const historical=JSON.parse(execFileSync('git',['show','73793c2df81f6bf9c81fe276b37997fa2159c67d:'+item.workspace+'/package.json'],
            {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}));
          assert.equal(historical.name,item.name);assert.equal(historical.version,item.version);
          assert.notEqual(packed.version,item.version);assert.notEqual(packed.integrity,item.existingArtifact.integrity);
          const {io,events,packed:originalPack}=await fixture();
          io.pack=async candidate=>candidate.name===item.name?packed:originalPack(candidate);
          await assert.rejects(m.publishDeviceMaintenance(head,io,{publish:true}),/packed version mismatch/);
          assert.equal(events.some(event=>event.startsWith('publish:')),false);
        }
      }
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
