import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

async function caller(overrides:Record<string,unknown>={}){
  const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const node=ast.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text==='assertSigningMaintenanceManagedCohort');
  assert.ok(node,'the real CLI must verify the installed managed cohort before maintenance');
  const compiled=ts.transpileModule(node.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}});
  const startup={version:'0.2.210',workspace:'/fixture/repo',launcher:'/fixture/repo/.dharma/bin/dharma',policy:'/fixture/repo/.dharma/approved-policy.json'};
  const calls:string[]=[],deps:Record<string,unknown>={VERSION:'0.2.210',process:{platform:'linux'},resolve:posix.resolve,
    realpath:async(path:string)=>path,
    lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:10,ino:1,dev:1,mtimeMs:1,ctimeMs:1}),
    inspectOwnedRelayAutostart:async()=>{calls.push('inspect');return startup;},
    readFile:async(path:string)=>{calls.push(path);return path.endsWith('dharma.cmd')?'windows':'shell';},
    verifyRecordedRepositoryLaunchers:async(version:string,launchers:unknown)=>{
      assert.equal(version,'0.2.210');assert.deepEqual(launchers,{shell:'shell',windows:'windows'});calls.push('verify');return true;},
    sha256:(value:string)=>value,...overrides};
  const run=compileFunction(compiled.outputText+'\nreturn assertSigningMaintenanceManagedCohort;',
    ['exports',...Object.keys(deps)])({},...Object.values(deps)) as (home:string,workspace:string)=>Promise<string>;
  return {run,startup,calls};
}
test('actual CLI rejects an older or mismatched managed startup before accepting maintenance authority',async()=>{
  for(const field of ['version','workspace','launcher','policy']){
    const f=await caller();(f.startup as Record<string,string>)[field]='old-or-foreign';
    await assert.rejects(f.run('/fixture/home','/fixture/repo'),/managed_cohort_upgrade_required/);
    assert.deepEqual(f.calls,['inspect']);
  }
});
test('actual CLI requires recorded current-version launcher parity rather than version metadata alone',async()=>{
  const f=await caller({verifyRecordedRepositoryLaunchers:async()=>false});
  await assert.rejects(f.run('/fixture/home','/fixture/repo'),/managed_cohort_upgrade_required/);
});
test('actual CLI returns a non-secret cohort digest only after owned startup and launcher verification',async()=>{
  const f=await caller();assert.equal(typeof await f.run('/fixture/home','/fixture/repo'),'string');
  assert.equal(f.calls.at(-1),'verify');
});
test('actual CLI refuses symlink, oversized or changing launcher files before accepting the cohort',async()=>{
  for(const kind of ['symlink','oversized','changed']){
    let reads=0;
    const f=await caller({lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>kind==='symlink',
      size:kind==='oversized'?65537:10,ino:kind==='changed'?++reads:1,dev:1,mtimeMs:1,ctimeMs:1})});
    await assert.rejects(f.run('/fixture/home','/fixture/repo'),/managed_cohort_upgrade_required/);
    assert.equal(f.calls.includes('verify'),false);
  }
});
