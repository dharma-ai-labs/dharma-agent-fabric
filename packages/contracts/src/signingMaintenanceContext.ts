import {types} from 'node:util';

export interface DeviceSigningMaintenanceSelection {
  organizationId:string;deviceId:string;installationId:string;workspaceId:string;setupReference:string;operationId:string;
}
export interface DeviceSigningMaintenanceContextRequest extends DeviceSigningMaintenanceSelection {
  schema:'dharma.device-signing-maintenance-context-request/v1';repositoryFingerprint:string;nonce:string;issuedAt:string;expiresAt:string;
}
export interface DeviceSigningMaintenanceSource {
  organizationId:string;workspaceId:string;repositoryBindingId:string;repositoryFingerprint:string;policyRevision:string;
  scopeDigest:string;contractDigest:string;sourceGenerationId:string;sourceReceiptId:string;sourceRevision:number;
  sourcePolicyRevision:string;sourcePolicyHash:string;
}
export interface DeviceSigningMaintenanceContext extends DeviceSigningMaintenanceSelection {
  schema:'dharma.device-signing-maintenance-context/v1';recipientMembershipId:string;nonce:string;expiresAt:string;
  authority:'current_source_context_only_not_consent';source:DeviceSigningMaintenanceSource;
}
const SELECTION=['organizationId','deviceId','installationId','workspaceId','setupReference','operationId'];
const REQUEST=['schema',...SELECTION,'repositoryFingerprint','nonce','issuedAt','expiresAt'];
const RESPONSE=['schema',...SELECTION,'recipientMembershipId','nonce','expiresAt','authority','source'];
const SOURCE=['organizationId','workspaceId','repositoryBindingId','repositoryFingerprint','policyRevision','scopeDigest','contractDigest',
  'sourceGenerationId','sourceReceiptId','sourceRevision','sourcePolicyRevision','sourcePolicyHash'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const HASH=/^sha256:[a-f0-9]{64}$(?![\s\S])/;
const invalid=():never=>{throw Error('device_signing_maintenance_context_invalid');};
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)
    ||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)return invalid();
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(fields).sort().join('\0')!==[...keys].sort().join('\0'))return invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const field=fields[key];if(!field?.enumerable||!Object.hasOwn(field,'value'))return invalid();
    Object.defineProperty(result,key,{value:field.value,enumerable:true});}
  return result;
}
function strings(value:Record<string,unknown>,except:string[]=[]){
  for(const [key,item]of Object.entries(value))if(!except.includes(key)
    &&(typeof item!=='string'||item.length<1||item.length>256||/[\x00-\x1f\x7f]/.test(item)))return invalid();
}
function time(value:unknown){
  if(typeof value!=='string'||value.length>40)return invalid();const at=Date.parse(value);
  if(!Number.isFinite(at)||new Date(at).toISOString()!==value)return invalid();return at;
}
function selection(body:Record<string,unknown>,expected:DeviceSigningMaintenanceSelection){
  const safe=record(expected,SELECTION);strings(body,['source']);strings(safe);
  if(!/^org_[A-Za-z0-9]+$(?![\s\S])/.test(String(body.organizationId)))return invalid();
  for(const key of SELECTION){if(body[key]!==safe[key]||key!=='organizationId'&&!UUID.test(String(body[key])))return invalid();}
}
export function parseDeviceSigningMaintenanceContextRequest(value:unknown,expected:DeviceSigningMaintenanceSelection,now:number):DeviceSigningMaintenanceContextRequest{
  try{
    const body=record(value,REQUEST);selection(body,expected);
    const issued=time(body.issuedAt),expiry=time(body.expiresAt);
    if(body.schema!=='dharma.device-signing-maintenance-context-request/v1'||!HASH.test(String(body.repositoryFingerprint))||!Number.isFinite(now)||issued>now||expiry<=now
      ||expiry<=issued||expiry-issued>60000||typeof body.nonce!=='string'
      ||!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(body.nonce)||Buffer.from(body.nonce,'base64url').toString('base64url')!==body.nonce)return invalid();
    return Object.freeze(body) as unknown as DeviceSigningMaintenanceContextRequest;
  }catch{return invalid();}
}
/** TLS/device-authenticated context is not consent, root trust, a grant or
 * native authority. Every later server phase rechecks current eligibility. */
export function parseDeviceSigningMaintenanceContext(value:unknown,request:DeviceSigningMaintenanceContextRequest,
  expectedSource:{repositoryBindingId:string;repositoryFingerprint:string},now:number):DeviceSigningMaintenanceContext{
  try{
    const raw=record(request,REQUEST),scope=Object.fromEntries(SELECTION.map(key=>[key,raw[key]])) as unknown as DeviceSigningMaintenanceSelection;
    const sent=parseDeviceSigningMaintenanceContextRequest(raw,scope,now),body=record(value,RESPONSE);
    selection(body,scope);const source=record(body.source,SOURCE),expected=record(expectedSource,['repositoryBindingId','repositoryFingerprint']);strings(source,['sourceRevision']);
    if(body.schema!=='dharma.device-signing-maintenance-context/v1'||body.authority!=='current_source_context_only_not_consent'
      ||body.nonce!==sent.nonce||!UUID.test(String(body.recipientMembershipId))||time(body.expiresAt)<=now||time(body.expiresAt)>time(sent.expiresAt)
      ||source.organizationId!==sent.organizationId||source.workspaceId!==sent.workspaceId
      ||source.repositoryBindingId!==expected.repositoryBindingId||source.repositoryFingerprint!==expected.repositoryFingerprint
      ||source.repositoryFingerprint!==sent.repositoryFingerprint)return invalid();
    for(const key of ['workspaceId','repositoryBindingId','sourceGenerationId'])if(!UUID.test(String(source[key])))return invalid();
    for(const key of ['repositoryFingerprint','scopeDigest','contractDigest','sourcePolicyHash'])if(!HASH.test(String(source[key])))return invalid();
    if(!Number.isSafeInteger(source.sourceRevision)||Number(source.sourceRevision)<1||Number(source.sourceRevision)>2147483646
      ||source.sourceReceiptId!=='repo_consent_'+source.sourceGenerationId||source.sourcePolicyRevision!=='repository-source-'+source.sourceGenerationId
      ||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(String(source.policyRevision)))return invalid();
    return Object.freeze({...body,source:Object.freeze(source)}) as unknown as DeviceSigningMaintenanceContext;
  }catch{return invalid();}
}
