import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import * as contracts from './index.js';
const at=Date.parse('2030-01-01T00:00:00.000Z'),id=(n:number)=>`da000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest='sha256:'+'a'.repeat(64);
const selection={organizationId:'org_fixture',deviceId:id(1),installationId:id(2),workspaceId:id(3),setupReference:id(4),operationId:id(5)};
const request={schema:'dharma.device-signing-maintenance-context-request/v1',...selection,
  repositoryFingerprint:digest,nonce:Buffer.alloc(32,7).toString('base64url'),issuedAt:new Date(at).toISOString(),expiresAt:new Date(at+60000).toISOString()};
const source={organizationId:'org_fixture',workspaceId:id(3),repositoryBindingId:id(6),repositoryFingerprint:digest,
  policyRevision:'agent-fabric-local-analysis-v1',scopeDigest:digest,contractDigest:digest,
  sourceGenerationId:id(7),sourceReceiptId:'repo_consent_'+id(7),sourceRevision:1,
  sourcePolicyRevision:'repository-source-'+id(7),sourcePolicyHash:digest};
const response={schema:'dharma.device-signing-maintenance-context/v1',...selection,recipientMembershipId:id(8),source,
  nonce:request.nonce,expiresAt:request.expiresAt,authority:'current_source_context_only_not_consent'};
function api(){
  const methods=contracts as unknown as Record<string,(...args:any[])=>any>;
  assert.equal(typeof methods.parseDeviceSigningMaintenanceContextRequest,'function');
  assert.equal(typeof methods.parseDeviceSigningMaintenanceContext,'function');return methods;
}
test('maintenance context binds the fixed existing device, operation and source without granting authority',()=>{
  const methods=api();assert.deepEqual(methods.parseDeviceSigningMaintenanceContextRequest!(request,selection,at),request);
  const parsed=methods.parseDeviceSigningMaintenanceContext!(response,request,{repositoryBindingId:id(6),repositoryFingerprint:digest},at);
  assert.deepEqual(parsed,response);assert.ok(Object.isFrozen(parsed)&&Object.isFrozen(parsed.source));
  for(const key of ['ready','token','grant','nativeSessionBindingDigest','approved','privateKey'])assert.equal(key in parsed,false);
});
test('maintenance context rejects cross-device, source, nonce, expiry and injected authority',()=>{
  const methods=api();
  for(const delta of [{deviceId:id(99)},{recipientMembershipId:'invalid'},{nonce:Buffer.alloc(32,8).toString('base64url')},
    {expiresAt:new Date(at+60001).toISOString()},{approved:true},{source:{...source,repositoryBindingId:id(99)}},
    {source:{...source,sourceRevision:0}},{source:{...source,sourceReceiptId:'guessed'}},{source:{...source,token:'SYNTHETIC'}}])
    assert.throws(()=>methods.parseDeviceSigningMaintenanceContext!({...response,...delta},request,{repositoryBindingId:id(6),repositoryFingerprint:digest},at));
  assert.throws(()=>methods.parseDeviceSigningMaintenanceContext!(response,request,{repositoryBindingId:id(6),repositoryFingerprint:digest},at+60000));
  assert.throws(()=>methods.parseDeviceSigningMaintenanceContextRequest!({...request,method:'POST'},selection,at));
});
test('published context schemas agree with the request and response runtime contracts',async()=>{
  const root=resolve(import.meta.dirname,'../../../schemas');
  for(const [name,value]of [['device-signing-maintenance-context-request',request],['device-signing-maintenance-context',response]] as const){
    assert.equal((await contracts.validateContract(root,'https://schemas.dharma-ai.io/'+name+'/v1',value)).ok,true);
    assert.equal((await contracts.validateContract(root,'https://schemas.dharma-ai.io/'+name+'/v1',{...value,approved:true})).ok,false);
  }
  const {repositoryFingerprint,...missing}=request;void repositoryFingerprint;
  assert.equal((await contracts.validateContract(root,'https://schemas.dharma-ai.io/device-signing-maintenance-context-request/v1',missing)).ok,false);
});
