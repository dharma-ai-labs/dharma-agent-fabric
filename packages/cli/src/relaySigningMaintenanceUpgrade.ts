import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {validateRelayUpgradeJournal,type RelayUpgradeDependencies} from './relayRuntimeUpgrade.js';

type Launchers={shell:string;windows:string};
type Input={home:string;workspace:string;organizationId:string;deviceId:string;workspaceId:string;version:string;
  trustGeneration:number;dryRun?:boolean;finish?:boolean;previousUpgradeSha256?:string};
type Dependencies=RelayUpgradeDependencies&{
  assertNamedDisabled():Promise<void>;
  assertStartupPaused():Promise<void>;
  assertRecoveredTrust(previousGeneration:number):Promise<void>;
  stageStartup(version:string,restore:{codexHome:string|null}):Promise<unknown>;
};
type State='prepared'|'staged'|'finishing'|'completed'|'staging_reverted'|'staging_failed'|'finish_failed';
type Journal={schema:'dharma.local-signing-maintenance-upgrade-journal/v1';upgradeId:string;organizationId:string;
  deviceId:string;workspaceId:string;workspace:string;version:string;previousVersion:string;previousCodexHome:string|null;
  previous:Launchers;next:Launchers;previousHash:string;nextHash:string;priorJournalSha256:string|null;
  priorJournalArchive:string|null;trustGeneration:number;createdAt:string;updatedAt:string;state:State};
const version=/^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const hash=(value:Launchers)=>sha(JSON.stringify(value));
const same=(left:Launchers,right:Launchers)=>left.shell===right.shell&&left.windows===right.windows;
const fail=(reason:string):never=>{throw Error('relay_signing_maintenance_'+reason);};
const context=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('/')&&value!=='/'
  &&value.length<=4096&&!/[\x00-\x1f\x7f]|\s$|\\$/.test(value)&&resolve(value)===value;
const states:State[]=['prepared','staged','finishing','completed','staging_reverted','staging_failed','finish_failed'];

async function readOwned(path:string,maximum=262144):Promise<string|null>{
  try{const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>maximum||await realpath(path)!==path
      ||process.platform!=='win32'&&(info.uid!==process.getuid!()||(info.mode&0o077)!==0))return fail('journal_unavailable');
    return await readFile(path,'utf8');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function launchers(workspace:string):Promise<Launchers>{
  const paths=['dharma','dharma.cmd'].map(name=>join(workspace,'.dharma','bin',name));
  for(const path of paths){const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16384||await realpath(path)!==path
      ||process.platform!=='win32'&&(info.uid!==process.getuid!()||(info.mode&0o022)!==0))return fail('launcher_conflict');}
  return{shell:await readFile(paths[0]!,'utf8'),windows:await readFile(paths[1]!,'utf8')};
}
async function atomic(path:string,value:string,mode:number){
  const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,value,{mode,flag:'wx'});
  await rename(temporary,path);if(process.platform!=='win32')await chmod(path,mode);
}
async function install(workspace:string,value:Launchers){
  await atomic(join(workspace,'.dharma','bin','dharma'),value.shell,0o700);
  await atomic(join(workspace,'.dharma','bin','dharma.cmd'),value.windows,0o600);
}
async function validateJournal(value:unknown,input:Input,deps:Dependencies):Promise<Journal>{
  const j=value as Journal,keys=['schema','upgradeId','organizationId','deviceId','workspaceId','workspace','version',
    'previousVersion','previousCodexHome','previous','next','previousHash','nextHash','priorJournalSha256',
    'priorJournalArchive','trustGeneration','createdAt','updatedAt','state'];
  const validLaunchers=(v:Launchers)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='shell,windows'
    &&typeof v.shell==='string'&&v.shell.length<=16384&&typeof v.windows==='string'&&v.windows.length<=16384;
  if(!j||typeof j!=='object'||Array.isArray(j)||Object.keys(j).length!==keys.length||Object.keys(j).some(k=>!keys.includes(k))
    ||j.schema!=='dharma.local-signing-maintenance-upgrade-journal/v1'||!uuid.test(j.upgradeId)
    ||j.organizationId!==input.organizationId||j.deviceId!==input.deviceId||j.workspaceId!==input.workspaceId
    ||j.workspace!==input.workspace||j.version!==input.version||!version.test(j.previousVersion)
    ||j.previousCodexHome!==null&&!context(j.previousCodexHome)||!validLaunchers(j.previous)||!validLaunchers(j.next)
    ||j.previousHash!==hash(j.previous)||j.nextHash!==hash(j.next)||!states.includes(j.state)
    ||!Number.isSafeInteger(j.trustGeneration)||j.trustGeneration<1
    ||!Number.isFinite(Date.parse(j.createdAt))||!Number.isFinite(Date.parse(j.updatedAt))
    ||j.priorJournalSha256!==null&&!/^sha256:[a-f0-9]{64}$/.test(j.priorJournalSha256)
    ||(j.priorJournalSha256===null)!==(j.priorJournalArchive===null)
    ||j.priorJournalArchive!==null&&!/^runtime-upgrade\.[a-f0-9-]{36}\.[a-f0-9]{64}\.history\.json$/.test(j.priorJournalArchive)
    ||!deps.verifyPriorLaunchers||!await deps.verifyPriorLaunchers(j.previousVersion,j.previous)
    ||!deps.verifyRecoveryLaunchers||!await deps.verifyRecoveryLaunchers(j.version,j.next))return fail('journal_unavailable');
  return j;
}

/** The CLI holds its existing home-wide startup lock around this transaction.
 * Staging is file-only maintenance, never a successful relay upgrade. Neither
 * a failed journal nor an ambiguous start can be turned into an automatic retry. */
export async function upgradeRelayForSigningMaintenance(input:Input,deps:Dependencies){
  if(!version.test(input.version)||![input.deviceId,input.workspaceId].every(v=>uuid.test(v))
    ||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.organizationId)
    ||!Number.isSafeInteger(input.trustGeneration)||input.trustGeneration<1
    ||input.previousUpgradeSha256!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(input.previousUpgradeSha256))return fail('options_invalid');
  for(const path of[input.home,input.workspace,join(input.home,'relay')]){
    const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path
      ||process.platform!=='win32'&&(info.uid!==process.getuid!()||(info.mode&0o022)!==0))return fail('scope_unavailable');}
  await deps.assertStopped();await deps.assertNamedDisabled();
  const directory=join(input.home,'relay'),path=join(directory,'signing-maintenance-upgrade.json');
  const legacyPath=join(directory,'runtime-upgrade.json'),legacyRaw=await readOwned(legacyPath,65536);
  const saved=await readOwned(path),startup=await deps.inspectStartup();
  if(startup.workspace!==input.workspace||startup.codexHome!==undefined&&!context(startup.codexHome))return fail('context_conflict');
  let journal:Journal;
  if(saved){
    journal=await validateJournal(JSON.parse(saved),input,deps);
    if(journal.state!=='staged')return fail('reconciliation_required');
    if(startup.version!==journal.version||(startup.codexHome??null)!==journal.previousCodexHome
      ||!same(await launchers(input.workspace),journal.next))return fail('launcher_conflict');
    if((legacyRaw===null?null:sha(legacyRaw))!==journal.priorJournalSha256)return fail('prior_journal_changed');
    if(journal.priorJournalArchive){const archive=await readOwned(join(directory,journal.priorJournalArchive),65536);
      if(archive!==legacyRaw)return fail('prior_journal_changed');}
    await deps.assertStartupPaused();
  }else{
    if(input.finish)return fail('staged_upgrade_required');
    const previous=await launchers(input.workspace),next=deps.launcherContents(input.version);
    if(!version.test(startup.version)||!deps.verifyPriorLaunchers||!await deps.verifyPriorLaunchers(startup.version,previous)
      ||!deps.verifyRecoveryLaunchers||!await deps.verifyRecoveryLaunchers(input.version,next))return fail('launcher_conflict');
    const before=startup.version.split('-')[0]!.split('.').map(Number),after=input.version.split('-')[0]!.split('.').map(Number);
    if(after[0]!<before[0]!||after[0]===before[0]&&(after[1]!<before[1]!||after[1]===before[1]&&after[2]!<=before[2]!))return fail('version_invalid');
    let archive:string|null=null;
    if(legacyRaw!==null){
      const old=JSON.parse(legacyRaw);
      await validateRelayUpgradeJournal(old,{...input,version:old.version},deps);
      if(!uuid.test(old.upgradeId))return fail('prior_failure_custody_required');
      if(!['completed','rolled_back'].includes(old.state)){
        if(old.state!=='rollback_failed'||input.previousUpgradeSha256!==sha(legacyRaw)
          ||startup.version!==old.previousVersion||!same(previous,old.previous))return fail('prior_failure_custody_required');
        if((startup.codexHome??null)!==(old.previousCodexHome??null))return fail('context_conflict');
      }
      archive='runtime-upgrade.'+old.upgradeId+'.'+sha(legacyRaw).slice(7)+'.history.json';
    }
    const at=new Date().toISOString();
    journal={schema:'dharma.local-signing-maintenance-upgrade-journal/v1',upgradeId:randomUUID(),
      organizationId:input.organizationId,deviceId:input.deviceId,workspaceId:input.workspaceId,workspace:input.workspace,
      version:input.version,previousVersion:startup.version,previousCodexHome:startup.codexHome??null,
      previous,next,previousHash:hash(previous),nextHash:hash(next),priorJournalSha256:legacyRaw===null?null:sha(legacyRaw),
      priorJournalArchive:archive,trustGeneration:input.trustGeneration,createdAt:at,updatedAt:at,state:'prepared'};
    await validateJournal(journal,input,deps);
  }
  const receipt=(state:State|'planned')=>({schema:'dharma.local-signing-maintenance-upgrade/v1',upgradeId:journal.upgradeId,
    organizationId:journal.organizationId,deviceId:journal.deviceId,workspaceId:journal.workspaceId,
    version:journal.version,previousVersion:journal.previousVersion,state,upgradeComplete:state==='completed',
    runtimeObservation:state==='completed'?'local_process_and_poll':['finishing','finish_failed','staging_failed'].includes(state)?'unconfirmed':'not_performed',
    ready:false,nativeContinuationAuthorized:false,priorJournalArchive:journal.priorJournalArchive,
    priorJournalSha256:journal.priorJournalSha256,createdAt:new Date().toISOString()});
  if(input.dryRun)return receipt('planned');
  const save=async(state:State)=>{journal.state=state;journal.updatedAt=new Date().toISOString();await atomic(path,JSON.stringify(journal,null,2)+'\n',0o600);};
  const assertLegacy=async()=>{if(await readOwned(legacyPath,65536)!==legacyRaw)return fail('prior_journal_changed');};
  if(!input.finish){
    if(saved)return receipt('staged');
    if(journal.priorJournalArchive){const archivePath=join(directory,journal.priorJournalArchive),existing=await readOwned(archivePath,65536);
      if(existing!==null&&existing!==legacyRaw)return fail('prior_journal_changed');
      if(existing===null)await writeFile(archivePath,legacyRaw!,{flag:'wx',mode:0o600});}
    await assertLegacy();await save('prepared');
    try{
      await deps.assertStopped();await deps.assertNamedDisabled();await assertLegacy();
      if(!same(await launchers(input.workspace),journal.previous))return fail('launcher_conflict');
      await deps.stageStartup(journal.previousVersion,{codexHome:journal.previousCodexHome});
      await deps.assertStartupPaused();await deps.assertStopped();await deps.assertNamedDisabled();await assertLegacy();
      await install(input.workspace,journal.next);
      await deps.stageStartup(journal.version,{codexHome:journal.previousCodexHome});
      const current=await deps.inspectStartup();
      if(current.version!==journal.version||current.workspace!==journal.workspace
        ||(current.codexHome??null)!==journal.previousCodexHome||!same(await launchers(input.workspace),journal.next))return fail('context_conflict');
      await deps.assertStartupPaused();await deps.assertStopped();await deps.assertNamedDisabled();await assertLegacy();await save('staged');return receipt('staged');
    }catch{
      try{
        await deps.assertStartupPaused();await deps.assertStopped();await deps.assertNamedDisabled();await assertLegacy();
        const current=await launchers(input.workspace);
        if(![journal.previous.shell,journal.next.shell].includes(current.shell)
          ||![journal.previous.windows,journal.next.windows].includes(current.windows))return fail('launcher_conflict');
        await install(input.workspace,journal.previous);await deps.stageStartup(journal.previousVersion,{codexHome:journal.previousCodexHome});
        const restored=await deps.inspectStartup();
        if(restored.version!==journal.previousVersion||restored.workspace!==journal.workspace
          ||(restored.codexHome??null)!==journal.previousCodexHome||!same(await launchers(input.workspace),journal.previous))return fail('context_conflict');
        await deps.assertStartupPaused();await deps.assertStopped();await assertLegacy();await save('staging_reverted');return receipt('staging_reverted');
      }catch{await save('staging_failed');return receipt('staging_failed');}
    }
  }
  await deps.assertRecoveredTrust(journal.trustGeneration);await deps.assertStartupPaused();await deps.assertStopped();await deps.assertNamedDisabled();await assertLegacy();
  await save('finishing');
  try{
    const since=new Date().toISOString();
    await deps.configureStartup(journal.version,{codexHome:journal.previousCodexHome});
    await deps.start();await deps.verify(journal.version,since);await assertLegacy();
    const ordinary={schema:'dharma.local-relay-upgrade-journal/v3',upgradeId:journal.upgradeId,
      organizationId:journal.organizationId,deviceId:journal.deviceId,workspaceId:journal.workspaceId,workspace:journal.workspace,
      previousVersion:journal.previousVersion,version:journal.version,startedAt:journal.createdAt,updatedAt:new Date().toISOString(),state:'completed',
      previous:journal.previous,previousHash:journal.previousHash,previousCodexHome:journal.previousCodexHome,next:journal.next,nextHash:journal.nextHash};
    await validateRelayUpgradeJournal(ordinary,input,deps);await atomic(legacyPath,JSON.stringify(ordinary,null,2)+'\n',0o600);
    await save('completed');return receipt('completed');
  }catch{
    // No restart of the expired previous version and no automatic finish replay.
    try{await deps.stop();}catch{/* Stop outcome is unconfirmed; preserve the failed admission. */}
    await save('finish_failed');return receipt('finish_failed');
  }
}
