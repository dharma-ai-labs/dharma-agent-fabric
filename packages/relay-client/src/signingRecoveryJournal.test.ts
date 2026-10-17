import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {canonicalize, signCanonicalObject, type DeviceSigningRecoveryChallenge,
  validateContract, type DeviceSigningRecoveryCandidate} from '@dharma-ai-labs/agent-fabric-contracts';
import {recoverDeviceEnrollmentConsistency, loadDeviceEnrollmentAnchor, saveDeviceConnectionPreference,
  type DeviceConfig, type DeviceEnrollmentAnchor, type SecureSecretStore} from './index.js';
import {HostOperationFence} from './hostOperationScope.js';
import {commitSigningRecoveryJournal, resumeSigningRecoveryJournal, type SigningRecoveryJournalIO} from './signingRecoveryJournal.js';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash = (v: string | Buffer) => 'sha256:' + createHash('sha256').update(v).digest('hex');
const objectHash = (v: unknown) => hash(canonicalize(v));
const digest = (c: string) => 'sha256:' + c.repeat(64);
function fixture(expired = true, connectionMode: 'manual'|'resume' = 'manual') {
  const previous = generateKeyPairSync('ed25519'), next = generateKeyPairSync('ed25519');
  const publicKey = (key: typeof previous) => key.publicKey.export({format:'jwk'}).x!;
  const keyset = (key: typeof previous, generation: number, issued: number, expires: number) => {
    const keyVersion = 'synthetic-key-version-' + generation;
    const body = {schema:'dharma.server-signing-keyset/v1' as const, organizationId:'org_fixture',generation,
      keys:[{keyVersion,publicKeyEd25519:publicKey(key),status:'active' as const,
        notBefore:new Date(issued).toISOString(),notAfter:new Date(expires).toISOString()}],
      signedByKeyVersion:keyVersion,issuedAt:new Date(issued).toISOString(),expiresAt:new Date(expires).toISOString()};
    return {...body,signature:signCanonicalObject(body,key.privateKey)};
  };
  const oldKeyset = keyset(previous,2,now-86400000,now+(expired?-1000:1000)), nextKeyset = keyset(next,3,now,now+86400000);
  const config: DeviceConfig = {schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic journal fixture',platform:'linux',
    publicKeyEd25519:publicKey(generateKeyPairSync('ed25519')),serverPublicKeyEd25519:publicKey(previous),
    serverSigningKeyset:oldKeyset,relayUrl:'wss://relay.example',enrolledAt:'2029-12-01T00:00:00.000Z',
    connectionMode,setupClaimReference:id(3),setupClaimRepositoryFingerprint:digest('a')};
  const anchor: DeviceEnrollmentAnchor = {schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,
    organizationId:config.organizationId,deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,
    serverPublicKeyEd25519:config.serverPublicKeyEd25519,serverSigningKeyset:oldKeyset,enrolledAt:config.enrolledAt};
  const challenge: DeviceSigningRecoveryChallenge = {schema:'dharma.device-signing-recovery-challenge/v1',
    purpose:'expired_signing_trust_reapproval',origin:config.hqUrl,issuer:config.hqUrl,audience:'dharma.agent-fabric.signing-recovery/v1',
    recoveryId:id(4),approvalId:id(5),organizationId:config.organizationId,recipientMembershipId:id(6),deviceId:config.deviceId,
    installationId:config.installationId!,workspaceId:id(7),publicKeyEd25519:config.publicKeyEd25519,
    credentialEncryptionPublicKey:publicKey(generateKeyPairSync('x25519')),repositoryFingerprint:digest('a'),
    policyRevision:'agent-fabric-policy-v1',scopeDigest:digest('b'),contractDigest:digest('c'),sourceSelectionDigest:digest('d'),
    nativeSessionBindingDigest:digest('e'),previousAnchorHash:objectHash(anchor),protectedConfigDigest:objectHash(config),
    previousGeneration:2,previousKeysetHash:objectHash(oldKeyset),previousRootFingerprint:hash(Buffer.from(publicKey(previous),'base64url')),
    candidateGeneration:3,candidateKeysetHash:objectHash(nextKeyset),candidateRootFingerprint:hash(Buffer.from(publicKey(next),'base64url')),
    candidateKeyVersionFingerprint:hash(nextKeyset.signedByKeyVersion),method:'POST',path:'/api/v1/agent-fabric/signing-recovery',
    nonce:Buffer.alloc(32,7).toString('base64url'),authenticator:Buffer.alloc(32,8).toString('base64url'),
    issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString()};
  const candidate: DeviceSigningRecoveryCandidate = {schema:'dharma.device-signing-recovery-candidate/v1',organizationId:config.organizationId,
    recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,rootPublicKey:publicKey(next),keysetCanonical:canonicalize(nextKeyset),
    publication:{schema:'dharma.signing-recovery-publication/v1',organizationId:config.organizationId,recoveryId:challenge.recoveryId,
      generation:3,artifactHash:digest('f'),publishedAt:new Date(now).toISOString()}};
  let currentConfig = structuredClone(config), current: string | null = JSON.stringify(anchor), legacy: string | null = null;
  let allowed = true, clock = now, failure = '', casCount = 0;
  const calls: string[] = [], protectedSentinels = ['SYNTHETIC_DEVICE_PRIVATE_KEY','SYNTHETIC_API_TOKEN'];
  const io: SigningRecoveryJournalIO = {fence:new HostOperationFence({signal:new AbortController().signal,current:async()=>allowed}),
    readConfig:async()=>structuredClone(currentConfig),readAnchors:async()=>({current,legacy}),
    compareAndPutAnchor:async input=>{
      calls.push('cas');casCount++;
      if(input.expectedCurrent!==current||input.expectedLegacy!==legacy)return false;
      current=input.secret;
      if(failure==='after-journal'&&casCount===1)throw Error('SYNTHETIC_UNCERTAIN_WRITE');
      if(failure==='withdraw-after-journal'&&casCount===1)allowed=false;
      return true;
    },writeConfig:async value=>{
      calls.push('config');if(failure==='before-config')throw Error('SYNTHETIC_CONFIG_FAILURE');
      currentConfig=structuredClone(value);
      if(failure==='after-config')throw Error('SYNTHETIC_UNCERTAIN_CONFIG');
    },now:()=>clock};
  return {config,anchor,challenge,candidate,io,calls,protectedSentinels,
    state:()=>({config:structuredClone(currentConfig),current,legacy}),
    change:(change:{config?:DeviceConfig;current?:string|null;legacy?:string|null;allowed?:boolean;clock?:number;failure?:string})=>{
      if(change.config)currentConfig=change.config;
      if(Object.hasOwn(change,'current'))current=change.current!;
      if(Object.hasOwn(change,'legacy'))legacy=change.legacy!;
      if(change.allowed!==undefined)allowed=change.allowed;
      if(change.clock!==undefined)clock=change.clock;
      if(change.failure!==undefined)failure=change.failure;
    }};
}
const denied = /^Error: signing_recovery_installation_unavailable$/;

test('protected journal commits only trust fields and preserves identity, enrollment, policy and credential slots',async()=>{
  const f=fixture();await commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge});
  const state=f.state(),next=JSON.parse(f.candidate.keysetCanonical);
  assert.deepEqual(state.config,{...f.config,serverPublicKeyEd25519:f.candidate.rootPublicKey,serverSigningKeyset:next});
  assert.deepEqual(JSON.parse(state.current!),{...f.anchor,serverPublicKeyEd25519:f.candidate.rootPublicKey,serverSigningKeyset:next});
  assert.deepEqual(f.calls,['cas','config','cas']);assert.equal(state.legacy,null);
  assert.deepEqual(f.protectedSentinels,['SYNTHETIC_DEVICE_PRIVATE_KEY','SYNTHETIC_API_TOKEN']);
});

for(const phase of ['after-journal','before-config','after-config'])test(`resume after ${phase} completes the original protected record, even after approval expiry`,async()=>{
  const f=fixture();f.change({failure:phase});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
  assert.equal(JSON.parse(f.state().current!).schema,'dharma.device-enrollment-recovery-journal/v1');
  f.change({failure:'',clock:now+700000});
  await resumeSigningRecoveryJournal(f.io);
  assert.equal(f.state().config.serverPublicKeyEd25519,f.candidate.rootPublicKey);
  assert.equal(JSON.parse(f.state().current!).schema,'dharma.device-enrollment-anchor/v1');
});

test('recovery cannot migrate authority across another installation, changed configuration, anchor or legacy slot',async()=>{
  for(const fault of ['installation','name','key','anchor','legacy','expired-candidate']){
    const f=fixture();f.change({failure:'before-config'});
    await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
    const state=f.state();
    if(fault==='installation')f.change({config:{...state.config,installationId:id(20)}});
    if(fault==='name')f.change({config:{...state.config,deviceName:'Changed'}});
    if(fault==='key')f.change({config:{...state.config,publicKeyEd25519:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x!}});
    if(fault==='anchor')f.change({current:state.current!+' '});
    if(fault==='legacy')f.change({legacy:'foreign-slot'});
    if(fault==='expired-candidate')f.change({clock:now+86400000});
    f.change({failure:''});const before=f.state();
    await assert.rejects(resumeSigningRecoveryJournal(f.io),denied);assert.deepEqual(f.state(),before);
  }
});

test('withdrawal after protected journal publication prevents config mutation and keeps recovery evidence',async()=>{
  const f=fixture();f.change({failure:'withdraw-after-journal'});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),/relay_host_scope_unavailable/);
  assert.deepEqual(f.state().config,f.config);assert.deepEqual(f.calls,['cas']);
  assert.equal(JSON.parse(f.state().current!).schema,'dharma.device-enrollment-recovery-journal/v1');
});

test('the protected journal schema excludes credentials and extra authority flags',async()=>{
  const f=fixture();f.change({failure:'before-config'});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
  const value=JSON.parse(f.state().current!),directory=resolve(import.meta.dirname,'../../../schemas');
  const schema='https://schemas.dharma-ai.io/device-enrollment-recovery-journal/v1';
  assert.equal((await validateContract(directory,schema,value)).ok,true);
  for(const change of [{approved:true},{token:'SYNTHETIC_SECRET'},{privateKey:'SYNTHETIC_SECRET'}])
    assert.equal((await validateContract(directory,schema,{...value,...change})).ok,false);
});

test('concurrent commit attempts cannot overwrite a winning journal or carry authority to another request',async()=>{
  const f=fixture();
  const input={io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge};
  const results=await Promise.allSettled([commitSigningRecoveryJournal(input),commitSigningRecoveryJournal(input)]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected').length,1);
  assert.equal(f.state().config.serverPublicKeyEd25519,f.candidate.rootPublicKey);
  assert.equal(f.calls.filter(v=>v==='config').length,1);
  const before=f.state();await assert.rejects(commitSigningRecoveryJournal(input),denied);assert.deepEqual(f.state(),before);
});

test('legacy-slot migration preserves the historical slot and rejects a competing legacy write',async()=>{
  const f=fixture(),legacy=f.state().current!;
  f.change({current:null,legacy});
  await commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge});
  assert.equal(f.state().legacy,legacy);assert.equal(JSON.parse(f.state().current!).schema,'dharma.device-enrollment-anchor/v1');
});

test('staging rejects forged context, expired approval, unexpired historical trust and noncanonical journal before mutation',async()=>{
  const f=fixture();
  for(const patch of [{expected:{...f.challenge,installationId:id(20)}},
    {challenge:{...f.challenge,previousAnchorHash:digest('0')}},{candidate:{...f.candidate,token:'SYNTHETIC_SECRET'}}]){
    await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge,...patch}),denied);
  }
  f.change({clock:now+600000});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.state().config,f.config);
  const live=fixture(false);
  await assert.rejects(commitSigningRecoveryJournal({io:live.io,challenge:live.challenge,candidate:live.candidate,expected:live.challenge}),denied);
  assert.deepEqual(live.calls,[]);
});

for(const backend of ['linux-secret-service','windows-credential-manager'] as const)
test(`normal startup completes an existing protected journal using ${backend} and the genuine host fence`,async t=>{
  const f=fixture();f.change({failure:'before-config'});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
  const root=await mkdtemp(resolve(tmpdir(),'fabric-journal-startup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=resolve(root,'device.json'),account='device-enrollment-'+createHash('sha256')
    .update(`${f.config.hqUrl}:${f.config.organizationId}:${f.config.deviceId}`).digest('hex').slice(0,32);
  const legacyAccount='device-enrollment-'+createHash('sha256').update(`${f.config.hqUrl}:${f.config.organizationId}`).digest('hex').slice(0,32);
  const values=new Map([[account,f.state().current!]]),calls:string[]=[];
  const store:SecureSecretStore={backend,get:async()=>{throw Error('cached read forbidden');},
    getFresh:async key=>{calls.push('read:'+key);return values.get(key)??null;},
    put:async(key,value)=>{calls.push('put');values.set(key,value);},delete:async()=>{throw Error('forbidden delete');},
    ...(backend==='windows-credential-manager'?{compareAndPutEnrollmentAnchor:async input=>{
      calls.push('windows-cas');assert.equal(input.account,account);assert.equal(input.legacyAccount,legacyAccount);
      if((values.get(account)??null)!==input.expectedCurrent||(values.get(legacyAccount)??null)!==input.expectedLegacy)return false;
      values.set(account,input.secret);return true;
    }}:{})};
  await writeFile(configPath,JSON.stringify(f.config));
  const input={configPath,store,now:new Date(now+700000),hostScope:{signal:new AbortController().signal,current:async()=>true}};
  await assert.rejects(recoverDeviceEnrollmentConsistency({...input,hostScope:undefined}),/signing_recovery_host_scope_required/);
  await assert.rejects(loadDeviceEnrollmentAnchor({config:f.config,store,readOnly:true}),/does not match/);
  if(backend==='windows-credential-manager'){
    const method=store.compareAndPutEnrollmentAnchor;delete store.compareAndPutEnrollmentAnchor;
    await assert.rejects(recoverDeviceEnrollmentConsistency(input),denied);
    store.compareAndPutEnrollmentAnchor=method;
  }
  const restored=await recoverDeviceEnrollmentConsistency(input);
  assert.equal(restored.deviceId,f.config.deviceId);assert.equal(restored.installationId,f.config.installationId);
  assert.equal(restored.serverPublicKeyEd25519,f.candidate.rootPublicKey);
  assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),restored);
  assert.equal((await loadDeviceEnrollmentAnchor({config:restored,store,readOnly:true})).serverPublicKeyEd25519,f.candidate.rootPublicKey);
  assert.ok(calls.every(v=>v==='put'||v==='windows-cas'||v==='read:'+account||v==='read:'+legacyAccount));
  assert.equal(calls.includes('windows-cas'),backend==='windows-credential-manager');
  assert.equal(calls.includes('put'),backend!=='windows-credential-manager');
});

test('startup preserves the preference file and never carries old-root automatic-resume consent to a new root',async t=>{
  const f=fixture(true,'resume');f.change({failure:'before-config'});
  await assert.rejects(commitSigningRecoveryJournal({io:f.io,challenge:f.challenge,candidate:f.candidate,expected:f.challenge}),denied);
  const root=await mkdtemp(resolve(tmpdir(),'fabric-journal-preference-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=resolve(root,'device.json'),account='device-enrollment-'+createHash('sha256')
    .update(`${f.config.hqUrl}:${f.config.organizationId}:${f.config.deviceId}`).digest('hex').slice(0,32);
  const values=new Map([[account,f.state().current!]]);
  const store:SecureSecretStore={backend:'linux-secret-service',get:async()=>{throw Error('cached read forbidden');},
    getFresh:async key=>values.get(key)??null,put:async(key,value)=>{values.set(key,value);},delete:async()=>{throw Error('forbidden delete');}};
  await writeFile(configPath,JSON.stringify(f.config));
  await saveDeviceConnectionPreference({configPath,config:f.config,connectionMode:'resume'});
  const preference=await readFile(configPath+'.connection.json','utf8');
  const result=await recoverDeviceEnrollmentConsistency({configPath,store,now:new Date(now+700000),
    hostScope:{signal:new AbortController().signal,current:async()=>true}});
  assert.equal(result.serverPublicKeyEd25519,f.candidate.rootPublicKey);
  assert.equal(result.connectionMode,'manual');
  assert.equal(await readFile(configPath+'.connection.json','utf8'),preference);
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).connectionMode,'resume','historical inline value is preserved, never acted on over a mismatched preference');
});
