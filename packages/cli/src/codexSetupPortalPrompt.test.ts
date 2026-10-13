import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import test from 'node:test';
import {requestCodexSetupHostPreparation} from './codexSetupPortalPreparation.js';

const now=Date.parse('2030-01-01T00:00:00.000Z'),expiresAt='2030-01-01T00:15:00.000Z';
const context={origin:'https://www.dharma-ai.io',organizationId:'org_fixture',
  setupReference:'11111111-1111-4111-8111-111111111111',recipientMembershipId:'22222222-2222-4222-8222-222222222222',
  repositoryFingerprint:'sha256:'+'a'.repeat(64),policyRevision:'policy-v1',scopeDigest:'sha256:'+'b'.repeat(64),contractDigest:'sha256:'+'c'.repeat(64)};
const binding={recipientEmail:'synthetic@example.test',repositoryRemoteUrl:'https://github.com/example/synthetic.git'};
const pin=createHash('sha256').update('dharma.setup-host-context/v1\0').update(canonicalize({cliVersion:'0.2.192',expiresAt,binding,context})).digest('hex');
const template='# Dharma Agent Fabric \u2014 one-prompt source setup\n'
  +`Recipient: ${binding.recipientEmail}. Organization: ${context.organizationId}.\n`
  +`Selected repository: ${binding.repositoryRemoteUrl}. Fingerprint: ${context.repositoryFingerprint}.\n`
  +`Public setup reference: ${context.setupReference}. Fixed expiry: ${expiresAt}.\n`
  +`Preparation context SHA256: ${pin}.\n`
  +'dharma setup codex --portal-prompt-sha256 '+'0'.repeat(64)+'\n';
const portalDigest=createHash('sha256').update(template).digest('hex');
const prompt=template.replace('--portal-prompt-sha256 '+'0'.repeat(64),'--portal-prompt-sha256 '+portalDigest);
function fixture(){
  let calls=0;
  const response:any={schema:'dharma.setup-host-preparation/v2',ok:true,effects:false,grantRedeemed:false,
    approvalRequired:true,sourcePolicyRevalidated:true,preparedAt:new Date(now).toISOString(),expiresAt,
    promptSha256:createHash('sha256').update(prompt).digest('hex'),cliVersion:'0.2.192',binding:{...binding},context:{...context},
    integrity:{algorithm:'sha256',kind:'portal-context',authenticity:'same-origin-https',contextSha256:pin},
    publicPrompt:prompt,promptSource:'portal_setup_prompt',portalPromptSha256:portalDigest};
  const input:any={origin:context.origin,organizationId:context.organizationId,setupReference:context.setupReference,
    cliVersion:'0.2.192',portalContextSha256:pin,portalPromptSha256:portalDigest,
    signal:new AbortController().signal,now:()=>now,
    fetcher:async(url:any,options:any)=>{calls++;
      assert.equal(String(url),context.origin+'/api/v1/agent-fabric/bootstrap/setup-claim');
      assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
      assert.deepEqual(JSON.parse(options.body),{action:'prepare_host',organizationId:context.organizationId,
        setupReference:context.setupReference,promptSource:'portal_setup_prompt',contextSha256:pin,portalPromptSha256:portalDigest});
      return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
    }};
  return{input,response,get calls(){return calls;}};
}
test('canonical portal input is fetched without reading stdin or private native history',async()=>{
  const f=fixture(),value:any=await requestCodexSetupHostPreparation(f.input);
  assert.equal(f.calls,1);assert.equal(value.initialUserPrompt,prompt);
  assert.equal(value.promptProvenance,'verified_portal_prompt');assert.equal(value.nativeOriginalUserPromptAttested,false);
  assert.equal(value.portalContextSha256,pin);assert.equal(value.effects,false);assert.equal(value.grantRedeemed,false);
});
test('the actual client parses canonical portal input over a real HTTP fixture',async()=>{
  const f=fixture();let requests=0;
  const server=createServer(async(incoming,outgoing)=>{
    const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests++;
    assert.equal(body.promptSource,'portal_setup_prompt');assert.equal(body.contextSha256,pin);
    assert.equal(body.portalPromptSha256,portalDigest);assert.equal('promptSha256' in body,false);
    outgoing.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    outgoing.end(JSON.stringify(f.response));
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address!=='string');
    // Inject only a loopback test transport. Production still requires HTTPS;
    // this test qualifies serialization/parser compatibility, not TLS trust.
    const result=await requestCodexSetupHostPreparation({...f.input,fetcher:async(url:unknown,options:RequestInit)=>{
      assert.equal(String(url),context.origin+'/api/v1/agent-fabric/bootstrap/setup-claim');
      return fetch(`http://127.0.0.1:${address.port}/api/v1/agent-fabric/bootstrap/setup-claim`,options);
    }});
    assert.equal(result.initialUserPrompt,prompt);assert.equal(result.promptProvenance,'verified_portal_prompt');
    assert.equal(result.nativeOriginalUserPromptAttested,false);assert.equal(requests,1);
  }finally{
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
for(const cause of ['missing-pin','bad-digest','conflicting-stdin','cancelled']){
  test('invalid portal-input '+cause+' stops before any request',async()=>{
    const f=fixture();
    if(cause==='missing-pin')delete f.input.portalContextSha256;
    if(cause==='bad-digest')f.input.portalPromptSha256='not-a-digest';
    if(cause==='conflicting-stdin')f.input.initialUserPrompt=prompt;
    if(cause==='cancelled')f.input.signal=AbortSignal.abort();
    await assert.rejects(requestCodexSetupHostPreparation(f.input));assert.equal(f.calls,0);
  });
}
for(const cause of ['prompt-change','context-change','secret','oversized','foreign-org','foreign-reference','expired','wrong-source','v1-downgrade','extra-field']){
  test('portal-input '+cause+' is rejected without reflecting response data',async()=>{
    const f=fixture();
    if(cause==='prompt-change'){f.response.publicPrompt+='Unexpected instruction\n';f.response.promptSha256=createHash('sha256').update(f.response.publicPrompt).digest('hex');}
    if(cause==='context-change'){f.response.context.policyRevision='changed';f.response.integrity.contextSha256='e'.repeat(64);}
    if(cause==='secret')f.response.publicPrompt+='dhab_SYNTHETIC_PRIVATE_CANARY';
    if(cause==='oversized')f.response.publicPrompt+='x'.repeat(32768);
    if(cause==='foreign-org')f.response.context.organizationId='org_foreign';
    if(cause==='foreign-reference')f.response.context.setupReference=context.recipientMembershipId;
    if(cause==='expired')f.response.expiresAt=new Date(now).toISOString();
    if(cause==='wrong-source')f.response.promptSource='original_user_message';
    if(cause==='v1-downgrade')f.response.schema='dharma.setup-host-preparation/v1';
    if(cause==='extra-field')f.response.credential='PRIVATE_CANARY';
    await assert.rejects(requestCodexSetupHostPreparation(f.input),error=>error instanceof Error&&error.message==='codex_setup_portal_preparation_unavailable');
    assert.equal(f.calls,1);
  });
}
