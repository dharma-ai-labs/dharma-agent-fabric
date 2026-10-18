import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lookupPublishedArtifact} from './publish-onboarding-release.mjs';

const repository='https://github.com/dharma-ai-labs/dharma-agent-fabric';
const manifestHash='405fcabde6720c0a2d99ab7f147ce8bd114c37f1b7c70e40a704a8322f392237',workflowHash='99e5af97bf5ab0ea7f5b229313204d83f28ca48599184aa03de78262c60e4118',testHash='0275aedf9e9efa3167850bd6e275e592837c1361121089253088cf2a94001023';
const manifestPath=new URL('./signing-upgrade-release.json',import.meta.url);
export const textHash=value=>createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');
export const normalizedWorkflowHash=value=>textHash(value.replace(/^(\s*SIGNING_PUBLISHER_SHA256:) [^\r\n]+$/gm,'$1 <publisher-pin>'));
const rawManifest=readFileSync(manifestPath,'utf8');
export const release=Object.freeze(JSON.parse(rawManifest));

export function assertSigningSource(expectedHead,s){
  assert.match(expectedHead??'',/^[a-f0-9]{40}$/,'exact reviewed main required');
  assert.equal(s.head,expectedHead,'dispatched head mismatch');
  assert.equal(s.remoteMain,expectedHead,'current remote main required');
  assert.equal(s.ref,'refs/heads/main','main-only release');
  assert.equal(s.baselineTree,release.baseline.tree,'reviewed baseline tree required');
  assert.equal(s.dirty,'','tracked source must be clean');
  assert.ok(s.untracked.every(p=>p.startsWith('release/')),'untracked source refused');
  assert.ok(s.changed.every(p=>release.allowedPaths.includes(p)),'unreviewed source delta');
  assert.equal(s.manifestHash,manifestHash,'release manifest changed');
  assert.match(s.expectedPublisherHash??'',/^[a-f0-9]{64}$/,'independent publisher pin required');
  assert.equal(s.publisherHash,s.expectedPublisherHash,'publisher bytes changed');
  assert.equal(s.workflowHash,workflowHash,'workflow changed');
  assert.equal(s.testHash,testHash,'release tests changed');
  assert.deepEqual(s.productHashes,release.productHashes,'product bytes changed');
  const root=structuredClone(s.baselineManifest);
  root.scripts['pack:verify']=root.scripts['pack:verify'].replace('scripts/publish-device-maintenance.test.mjs &&',
    'scripts/publish-device-maintenance.test.mjs scripts/publish-signing-upgrade.test.mjs &&');
  root.scripts['publish:signing-upgrade']='node scripts/publish-signing-upgrade.mjs';
  root.scripts['test:signing-upgrade']='node --test scripts/publish-signing-upgrade.test.mjs';
  assert.deepEqual(s.manifest,root,'root manifest changed beyond release-test admission');
  const cli=structuredClone(s.baselineCliManifest);cli.version=release.cli.version;
  assert.deepEqual(s.cliManifest,cli,'CLI manifest changed beyond version');
  const lock=structuredClone(s.baselineLock);lock.packages['packages/cli'].version=release.cli.version;
  assert.deepEqual(s.lock,lock,'lock changed beyond CLI version');
}

function assertArtifact(item,packed,metadata){
  assert.equal(packed.name,item.name,'packed name mismatch');assert.equal(packed.version,item.version,'packed version mismatch');
  assert.match(packed.integrity??'',/^sha512-[A-Za-z0-9+/]{86}==$/,'pack integrity required');
  assert.equal(metadata?.name,item.name,'registry name mismatch');assert.equal(metadata.version,item.version,'registry version mismatch');
  assert.equal(metadata.dist?.integrity,packed.integrity,'registry integrity mismatch');
  const basename=item.name.split('/').at(-1);
  assert.equal(metadata.dist.tarball,`https://registry.npmjs.org/${item.name}/-/${basename}-${item.version}.tgz`,'registry tarball mismatch');
  const proof=new URL(metadata.dist.attestations.url);
  assert.equal(proof.origin,'https://registry.npmjs.org','provenance origin mismatch');
  assert.ok(proof.pathname.startsWith('/-/npm/v1/attestations/'),'provenance path mismatch');
}

export async function publishSigningUpgrade(head,io,{publish=false}={}){
  await io.verifySource(head);
  // All immutable dependencies and the CLI are qualified before the sole write.
  for(const item of release.dependencies){
    const packed=await io.pack(item);assert.equal(packed.integrity,item.integrity,'immutable dependency changed');
    const metadata=await io.lookup(item);assert.ok(metadata,'immutable dependency unavailable');
    assertArtifact(item,packed,metadata);await io.verifyPublished(item,packed,metadata,item.source);
  }
  const item=release.cli,packed=await io.pack(item);
  assert.equal(packed.name,item.name);assert.equal(packed.version,item.version);
  assert.match(packed.integrity??'',/^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(packed.filename,`dharma-ai-labs-agent-fabric-${item.version}.tgz`,'unexpected CLI pack filename');
  const existing=await io.lookup(item);
  if(existing){assertArtifact(item,packed,existing);await io.verifyPublished(item,packed,existing,head);
    return{state:'already_published_verified',writes:0,integrity:packed.integrity};}
  await io.verifySource(head);
  if(!publish)return{state:'ready_not_published',writes:0,integrity:packed.integrity};
  await io.publish(item,packed);
  const metadata=await io.lookup(item,true);assert.ok(metadata,'publication unconfirmed; reconcile, never replay');
  assertArtifact(item,packed,metadata);await io.verifyPublished(item,packed,metadata,head);
  return{state:'published_verified',writes:1,integrity:packed.integrity};
}

export async function runSigningCommand(args,io){
  assert.ok(args.length===2||args.length===3,'fixed command required');
  assert.equal(args[0],'--expected-head');assert.match(args[1]??'',/^[a-f0-9]{40}$/);
  assert.ok(args.length===2||['--publish','--admission-only'].includes(args[2]),'unknown option');
  if(args[2]==='--admission-only'){await io.verifySource(args[1]);return{state:'source_admitted',writes:0};}
  return publishSigningUpgrade(args[1],io,{publish:args[2]==='--publish'});
}

export function assertReleaseProvenance(item,packed,attestations,source){
  const cli=item.name===release.cli.name;
  const expected=cli?release.cli:release.dependencies.find(d=>d.name===item.name);
  assert.ok(expected,'unreviewed provenance package');assert.equal(item.version,expected.version,'provenance version mismatch');
  if(!cli)assert.equal(source,expected.source,'immutable dependency source mismatch');
  const ref=cli?'refs/heads/main':expected.publisherRef;
  assert.match(ref,/^refs\/(heads\/main|tags\/v\d+\.\d+\.\d+)$/,'reviewed publisher reference required');
  const statements=attestations?.attestations?.map(a=>JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload,'base64').toString('utf8')));
  const statement=statements?.find(s=>s.predicateType==='https://slsa.dev/provenance/v1');assert.ok(statement,'SLSA provenance missing');
  const definition=statement.predicate.buildDefinition;
  assert.deepEqual(definition.externalParameters.workflow,{ref,repository,
    path:cli?'.github/workflows/publish-signing-upgrade.yml':'.github/workflows/publish.yml'},'publisher workflow mismatch');
  assert.ok(definition.resolvedDependencies.some(d=>d.uri===`git+${repository}@${ref}`&&d.digest?.gitCommit===source),'publisher source mismatch');
  const digest=Buffer.from(packed.integrity.slice(7),'base64').toString('hex');
  assert.ok(statement.subject.some(s=>s.name===`pkg:npm/${item.name.replace('@','%40')}@${item.version}`&&s.digest?.sha512===digest),'CLI provenance subject mismatch');
}

export function assertPreservedRuntime(item,snapshot){
  assert.ok(['@dharma-ai-labs/agent-fabric-sdk','@dharma-ai-labs/agent-fabric-skill-manager'].includes(item.name),'preserved package not reviewed');
  assert.ok(item.preserveOriginal,'exact historical artifact contract required');
  assert.equal(snapshot.integrity,item.integrity,'historical artifact integrity mismatch');
  assert.deepEqual(snapshot.sourceChanges.slice().sort(),item.preserveOriginal.sourceChanges.slice().sort(),'unreviewed historical source drift');
  assert.deepEqual(snapshot.publishedManifest,snapshot.localManifest,'historical manifest drift');
  const expected=Object.keys(item.preserveOriginal.runtimeHashes).sort();
  assert.deepEqual(Object.keys(snapshot.publishedRuntime).sort(),expected,'historical runtime file set changed');
  assert.deepEqual(Object.keys(snapshot.localRuntime).sort(),expected,'local runtime file set changed');
  for(const name of expected){
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(snapshot.publishedRuntime[name]),item.preserveOriginal.runtimeHashes[name],'historical runtime bytes changed');
    assert.equal(hash(snapshot.localRuntime[name]),item.preserveOriginal.runtimeHashes[name],'local runtime bytes changed');
  }
}

export async function packPreservedDependency(item,root,directory,{read=publicGet,git}={}){
  assert.ok(item.preserveOriginal&&typeof git==='function','reviewed historical package context required');
  const basename=item.name.split('/').at(-1),filename=item.name.slice(1).replace('/','-')+'-'+item.version+'.tgz';
  const bytes=await read(`https://registry.npmjs.org/${item.name}/-/${basename}-${item.version}.tgz`,false);
  assert.ok(bytes&&bytes.length<=131072,'bounded immutable artifact required');
  const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');assert.equal(integrity,item.integrity,'historical artifact integrity mismatch');
  const file=join(directory,filename);writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
  const tar=(...args)=>execFileSync('tar',args,{timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  const entries=tar('-tzf',file).toString('utf8').trim().split(/\r?\n/);
  assert.ok(entries.length>0&&entries.length<1000&&new Set(entries).size===entries.length,'bounded unique archive entries required');
  assert.ok(entries.every(p=>p.startsWith('package/')&&!p.includes('\\')&&!p.split('/').includes('..')&&!p.includes('\0')),'unsafe archive entry');
  const runtime=entries.filter(p=>p.startsWith('package/dist/')&&p.endsWith('.js')&&!p.endsWith('.test.js'));
  const publishedRuntime=Object.fromEntries(runtime.map(p=>[p.slice(8),tar('-xOf',file,p)]));
  const localRuntime={};
  function walk(relative){for(const entry of readdirSync(join(root,item.workspace,relative),{withFileTypes:true})){
    const name=relative+'/'+entry.name;
    assert.ok(!entry.isSymbolicLink(),'local runtime symlink refused');
    if(entry.isDirectory())walk(name);else if(entry.isFile()&&name.endsWith('.js')&&!name.endsWith('.test.js'))localRuntime[name]=readFileSync(join(root,item.workspace,name));
  }}walk('dist');
  assertPreservedRuntime(item,{integrity,sourceChanges:git('diff','--name-only',item.source,'HEAD','--',item.workspace).split('\n').filter(Boolean),
    publishedManifest:JSON.parse(tar('-xOf',file,'package/package.json').toString('utf8')),
    localManifest:JSON.parse(readFileSync(join(root,item.workspace,'package.json'),'utf8')),publishedRuntime,localRuntime});
  return{name:item.name,version:item.version,filename,integrity,preservedOriginalArtifact:true};
}

async function publicGet(url,json=true,timeout=30000){
  assert.equal(new URL(url).origin,'https://registry.npmjs.org','public registry only');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(response.status===404)return null;assert.ok(response.ok,`registry HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=33554432,'bounded public response required');
  return json?JSON.parse(bytes.toString('utf8')):bytes;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const root=resolve(import.meta.dirname,'..');let directory;
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:8388608}).trim();
  const text=p=>readFileSync(join(root,p),'utf8'),json=p=>JSON.parse(text(p));
  const baseline=p=>JSON.parse(git('show',release.baseline.commit+':'+p));
  const npm=(...args)=>{assert.ok(process.env.npm_execpath,'normal npm execution required');
    return execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8388608,stdio:['ignore','pipe','pipe']});};
  const result=await runSigningCommand(process.argv.slice(2),{
    verifySource:async head=>{
      git('merge-base','--is-ancestor',release.baseline.commit,'HEAD');
      const remote=git('ls-remote','--exit-code','origin','refs/heads/main');assert.match(remote,/^[a-f0-9]{40}\trefs\/heads\/main$/,'exact remote main read required');
      assertSigningSource(head,{head:git('rev-parse','HEAD'),remoteMain:remote.slice(0,40),ref:process.env.GITHUB_REF,
        baselineTree:git('rev-parse',release.baseline.commit+'^{tree}'),dirty:git('status','--porcelain','--untracked-files=no'),
        changed:git('diff','--name-only',release.baseline.commit,'HEAD').split('\n').filter(Boolean),
        untracked:git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean),
        manifestHash:textHash(rawManifest),publisherHash:textHash(readFileSync(import.meta.filename,'utf8')),
        expectedPublisherHash:process.env.SIGNING_PUBLISHER_SHA256,workflowHash:normalizedWorkflowHash(text('.github/workflows/publish-signing-upgrade.yml')),
        testHash:textHash(text('scripts/publish-signing-upgrade.test.mjs')),
        productHashes:Object.fromEntries(Object.keys(release.productHashes).map(p=>[p,textHash(text(p))])),
        baselineManifest:baseline('package.json'),manifest:json('package.json'),
        baselineCliManifest:baseline('packages/cli/package.json'),cliManifest:json('packages/cli/package.json'),
        baselineLock:baseline('package-lock.json'),lock:json('package-lock.json')});
    },
    pack:async item=>{directory??=mkdtempSync(join(tmpdir(),'dharma-signing-cli-release-'));
      if(item.preserveOriginal)return packPreservedDependency(item,root,directory,{git});
      return JSON.parse(npm('pack','--workspace',item.workspace,'--json','--pack-destination',directory))[0];},
    lookup:async(item,published)=>{const read=timeout=>publicGet(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`,true,timeout);
      return published?lookupPublishedArtifact(read):read(30000);},
    publish:async(_item,packed)=>{console.log(npm('publish',join(directory,packed.filename),'--access','public','--tag','latest','--provenance'));},
    verifyPublished:async(item,packed,metadata,source)=>{
      const bytes=await publicGet(metadata.dist.tarball,false);assert.ok(bytes,'published artifact missing');
      assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),packed.integrity,'published bytes mismatch');
      const proof=await lookupPublishedArtifact(timeout=>publicGet(metadata.dist.attestations.url,true,timeout));assert.ok(proof,'provenance visibility unconfirmed');
      assertReleaseProvenance(item,packed,proof,source);
    }});
  console.log(JSON.stringify(result));
}
