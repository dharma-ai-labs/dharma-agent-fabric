import {createHash, createPublicKey} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize, parseDeviceSigningRecoveryCandidate, parseDeviceSigningRecoveryChallenge,
  validateDeviceConfigContract, verifyInitialServerSigningKeyset,
  type DeviceSigningRecoveryCandidate, type DeviceSigningRecoveryChallenge,
  type DeviceSigningRecoveryContext} from '@dharma-ai-labs/agent-fabric-contracts';
import type {DeviceConfig, DeviceEnrollmentAnchor} from './index.js';
import type {HostOperationFence} from './hostOperationScope.js';

const SCHEMA = 'dharma.device-enrollment-recovery-journal/v1';
const MAX_BYTES = 131072;
const fail = (): never => {throw Error('signing_recovery_installation_unavailable');};
const hash = (value: string | Buffer) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const objectHash = (value: unknown) => hash(canonicalize(value));
const nullableHash = (value: string | null) => value === null ? null : hash(value);

/** Package-private, never a model/tool argument or a new public installer.
 * The caller holds the existing OS-user enrollment lock. Windows writes must
 * use the shared-vault CAS, not get/put or a Linux-only lock. */
export interface SigningRecoveryJournalIO {
  fence: HostOperationFence;
  readConfig(): Promise<DeviceConfig>;
  readAnchors(): Promise<{current: string | null; legacy: string | null}>;
  compareAndPutAnchor(input: {expectedCurrent: string | null; expectedLegacy: string | null; secret: string}): Promise<boolean>;
  writeConfig(value: DeviceConfig): Promise<void>;
  now(): number;
}
interface Journal {
  schema: typeof SCHEMA;
  acceptedAt: string;
  challenge: DeviceSigningRecoveryChallenge;
  candidate: DeviceSigningRecoveryCandidate;
  previousAnchor: string;
  previousCurrentHash: string | null;
  previousLegacyHash: string | null;
  previousConnectionMode: 'manual' | 'resume' | null;
  nextConfigDigest: string;
}
function anchor(config: DeviceConfig): DeviceEnrollmentAnchor {
  return {schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,
    serverPublicKeyEd25519:config.serverPublicKeyEd25519,serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt};
}
function json(text: string): Record<string, unknown> {
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_BYTES)return fail();
  const value: unknown=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  return value as Record<string,unknown>;
}
function exact(value: Record<string,unknown>,keys:string[]) {
  if(Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))return fail();
}
function snapshot<T>(value:T): T {
  if(!value||typeof value!=='object'||types.isProxy(value)||Object.getOwnPropertySymbols(value).length)return fail();
  for(const field of Object.values(Object.getOwnPropertyDescriptors(value)))
    if(!field.enumerable||!Object.hasOwn(field,'value'))return fail();
  return JSON.parse(canonicalize(value)) as T;
}
function checkedConfig(value:DeviceConfig):DeviceConfig {
  const result=snapshot(value);
  if(!validateDeviceConfigContract(result)||!result.installationId||!result.serverSigningKeyset)return fail();
  return result;
}
function verifyPrevious(config:DeviceConfig,previousAnchor:string,challenge:DeviceSigningRecoveryChallenge,acceptedAt:number) {
  const previous=json(previousAnchor);
  exact(previous,['schema','hqUrl','organizationId','deviceId','devicePublicKeyEd25519','serverPublicKeyEd25519','serverSigningKeyset','enrolledAt']);
  const keyset=config.serverSigningKeyset!;
  if(canonicalize(previous)!==canonicalize(anchor(config))||objectHash(previous)!==challenge.previousAnchorHash
    ||objectHash(config)!==challenge.protectedConfigDigest||objectHash(keyset)!==challenge.previousKeysetHash
    ||keyset.generation!==challenge.previousGeneration||config.hqUrl!==challenge.origin||config.organizationId!==challenge.organizationId
    ||config.installationId!==challenge.installationId||config.deviceId!==challenge.deviceId||config.publicKeyEd25519!==challenge.publicKeyEd25519
    ||config.setupClaimRepositoryFingerprint!==challenge.repositoryFingerprint
    ||hash(Buffer.from(config.serverPublicKeyEd25519,'base64url'))!==challenge.previousRootFingerprint)return fail();
  const expiry=Date.parse(keyset.expiresAt),signer=keyset.keys.find(key=>key.keyVersion===keyset.signedByKeyVersion);
  if(!Number.isFinite(expiry)||expiry>acceptedAt||!signer||Date.parse(signer.notBefore)>=expiry||Date.parse(signer.notAfter)<expiry)return fail();
  const root=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:config.serverPublicKeyEd25519}});
  if(!verifyInitialServerSigningKeyset(keyset,root,config.organizationId,new Date(expiry-1)).ok)return fail();
}
function nextConfig(previous:DeviceConfig,candidate:DeviceSigningRecoveryCandidate):DeviceConfig {
  return checkedConfig({...previous,serverPublicKeyEd25519:candidate.rootPublicKey,serverSigningKeyset:JSON.parse(candidate.keysetCanonical)});
}
function parseJournal(serialized:string,current:DeviceConfig,now:number) {
  const value=json(serialized);
  exact(value,['schema','acceptedAt','challenge','candidate','previousAnchor','previousCurrentHash','previousLegacyHash','previousConnectionMode','nextConfigDigest']);
  if(value.schema!==SCHEMA||canonicalize(value)!==serialized||typeof value.acceptedAt!=='string'
    ||typeof value.previousAnchor!=='string'||value.previousAnchor.length>65536||typeof value.nextConfigDigest!=='string'
    ||![null,'manual','resume'].includes(value.previousConnectionMode as null|string))return fail();
  const acceptedAt=Date.parse(value.acceptedAt);
  if(!Number.isFinite(now)||!Number.isFinite(acceptedAt)||acceptedAt>now||new Date(acceptedAt).toISOString()!==value.acceptedAt)return fail();
  // Only an already-protected journal is checked at its original acceptance
  // time. This is completion of a committed local transaction, not fresh use
  // of an expired browser approval. Candidate trust itself must still be live.
  const c=value.challenge as DeviceSigningRecoveryChallenge;
  const candidate=parseDeviceSigningRecoveryCandidate(value.candidate,c,c,acceptedAt);
  const challenge=parseDeviceSigningRecoveryChallenge(c,c,acceptedAt);
  const previous=json(value.previousAnchor) as unknown as DeviceEnrollmentAnchor;
  const config=checkedConfig(current);
  const {connectionMode:_mode,...withoutMode}=config;void _mode;
  const restored=checkedConfig({...withoutMode,...(value.previousConnectionMode===null?{}:{connectionMode:value.previousConnectionMode as 'manual'|'resume'}),
    serverPublicKeyEd25519:previous.serverPublicKeyEd25519,serverSigningKeyset:previous.serverSigningKeyset});
  verifyPrevious(restored,value.previousAnchor,challenge,acceptedAt);
  const next=nextConfig(restored,candidate);
  // The existing preference reader deliberately turns a root-mismatched opt-in
  // into manual mode. Never rewrite that preference or resurrect inline resume.
  const currentDigest=objectHash(config),isNext=[objectHash(next),objectHash({...next,connectionMode:'manual'})].includes(currentDigest);
  if(objectHash(next)!==value.nextConfigDigest||!(currentDigest===challenge.protectedConfigDigest||isNext)
    ||Date.parse(next.serverSigningKeyset!.expiresAt)<=now)return fail();
  const priorHash=hash(value.previousAnchor);
  if(value.previousCurrentHash!==null&&value.previousCurrentHash!==priorHash)return fail();
  if(value.previousCurrentHash===null&&value.previousLegacyHash!==priorHash)return fail();
  if(value.previousLegacyHash!==null&&(typeof value.previousLegacyHash!=='string'
    ||!/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(value.previousLegacyHash)))return fail();
  return {journal:value as unknown as Journal,next,current:config,isNext};
}
async function guarded<T>(io:SigningRecoveryJournalIO,operation:()=>Promise<T>):Promise<T> {return io.fence.step(operation);}
async function confirm(io:SigningRecoveryJournalIO,expectedCurrent:string|null,expectedLegacy:string|null,secret:string) {
  if(!await guarded(io,()=>io.compareAndPutAnchor({expectedCurrent,expectedLegacy,secret})))return fail();
  const read=await guarded(io,()=>io.readAnchors());
  if(read.current!==secret||read.legacy!==expectedLegacy)return fail();
}

/** Internal commit primitive. NOT exported by the relay package and NOT wired
 * to a CLI/tool. The future authenticated owning-host flow must first verify
 * current publication, both exact consents and current source/session scope.
 * A caller-supplied approved flag or decrypted envelope is not that authority. */
export async function commitSigningRecoveryJournal(input:{io:SigningRecoveryJournalIO;challenge:DeviceSigningRecoveryChallenge;
  candidate:unknown;expected:DeviceSigningRecoveryContext}):Promise<DeviceConfig> {
  const {io}=input;
  try {
    await io.fence.assert();const now=io.now();
    const candidate=parseDeviceSigningRecoveryCandidate(input.candidate,input.challenge,input.expected,now);
    const challenge=parseDeviceSigningRecoveryChallenge(input.challenge,input.expected,now);
    const config=checkedConfig(await guarded(io,()=>io.readConfig())),slots=await guarded(io,()=>io.readAnchors());
    const previousAnchor=slots.current??slots.legacy;if(previousAnchor===null)return fail();
    verifyPrevious(config,previousAnchor,challenge,now);
    const next=nextConfig(config,candidate),journal:Journal={schema:SCHEMA,acceptedAt:new Date(now).toISOString(),challenge,candidate,
      previousAnchor,previousCurrentHash:nullableHash(slots.current),previousLegacyHash:nullableHash(slots.legacy),
      previousConnectionMode:config.connectionMode??null,nextConfigDigest:objectHash(next)};
    const serialized=canonicalize(journal);parseJournal(serialized,config,now);
    // Recheck after async preparation; no journal may be admitted after expiry.
    parseDeviceSigningRecoveryCandidate(candidate,challenge,input.expected,io.now());
    if(objectHash(await guarded(io,()=>io.readConfig()))!==challenge.protectedConfigDigest)return fail();
    await confirm(io,slots.current,slots.legacy,serialized);
    return await resumeSigningRecoveryJournal(io);
  }catch{await io.fence.assert();return fail();}
}

/** Invoked only for this special protected slot while the existing enrollment
 * lock is held. Old clients reject its schema and cannot overwrite it as v1. */
export async function resumeSigningRecoveryJournal(io:SigningRecoveryJournalIO):Promise<DeviceConfig> {
  try {
    const slots=await guarded(io,()=>io.readAnchors());if(slots.current===null)return fail();
    const current=await guarded(io,()=>io.readConfig()),{journal,next,isNext}=parseJournal(slots.current,current,io.now());
    if(nullableHash(slots.legacy)!==journal.previousLegacyHash)return fail();
    if(!isNext){
      const before=await guarded(io,()=>io.readAnchors());
      if(before.current!==slots.current||before.legacy!==slots.legacy)return fail();
      await guarded(io,()=>io.writeConfig(next));
    }
    const completed=parseJournal(slots.current,await guarded(io,()=>io.readConfig()),io.now());
    if(!completed.isNext)return fail();
    // Revalidate time after async disk I/O; never return newly expired trust.
    parseJournal(slots.current,next,io.now());
    await confirm(io,slots.current,slots.legacy,JSON.stringify(anchor(next)));
    const final=parseJournal(slots.current,await guarded(io,()=>io.readConfig()),io.now());
    if(!final.isNext)return fail();
    return final.current;
  }catch{await io.fence.assert();return fail();}
}
