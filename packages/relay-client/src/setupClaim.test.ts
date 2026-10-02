import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { claimSetupReference, parseSetupClaimRecipientApproval, setupClaimSourceRegistration } from './setupClaim.js';
import { loadOrganizationApiToken } from './index.js';
import { sealSetupClaimCredential, signCanonicalObject, setupClaimSigningPayload, validateContract,
  type SetupClaimChallenge, type SealedSetupClaimCredential, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

const scope = {
  hqUrl: 'https://hq.example', organizationId: 'org_demo',
  setupReference: '11111111-1111-4111-8111-111111111111',
  recipientMembershipId: '22222222-2222-4222-8222-222222222222',
  repositoryFingerprint: `sha256:${'a'.repeat(64)}`, scopeDigest: `sha256:${'b'.repeat(64)}`,
  contractDigest: `sha256:${'c'.repeat(64)}`, policyRevision: 'policy-v1',
  name: 'Synthetic client', platform: 'linux' as const, configPath: 'unused-device.json',
};
function store(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service', get: async k => values.get(k) ?? null,
    put: async (k, v) => { values.set(k, v); }, delete: async k => { values.delete(k); } };
}
test('locked protected store fails before any HTTP operation and sanitizes vendor errors', async () => {
  let requests = 0;
  const locked = store(); locked.get = async () => { throw new Error('secret-canary'); };
  await assert.rejects(claimSetupReference({ ...scope, store: locked,
    fetcher: async () => { requests++; throw new Error('network'); } }), /^Error: setup_claim_failed$/);
  assert.equal(requests, 0);
});
test('protected store write denial fails before challenge, including readable existing stores',async()=>{
  let requests=0; const locked=store(); locked.put=async()=>{throw new Error('secret-canary');};
  await assert.rejects(claimSetupReference({...scope,store:locked,fetcher:async()=>{
    requests++;return Response.json({});
  }}),/^Error: setup_claim_failed$/);
  assert.equal(requests,0);
});
test('transport denies redirects, oversized responses and reflected server errors', async () => {
  for (const response of [new Response(JSON.stringify({ error: 'secret-canary' }), { status: 500 }),
    new Response('x'.repeat(65_537)), new Response('{}', { status: 302 })]) {
    await assert.rejects(claimSetupReference({ ...scope, store: store(), fetcher: async (_url, init) => {
      assert.equal(init?.redirect, 'error'); return response;
    } }), /^Error: setup_claim_failed$/);
  }
});
test('wrong scope and expired challenges never finalize', async () => {
  for (const changed of [{ scopeDigest: `sha256:${'d'.repeat(64)}` }, { expiresAt: '2020-01-01T00:00:00.000Z' }]) {
    let requests = 0;
    await assert.rejects(claimSetupReference({ ...scope, store: store(), fetcher: async (_url, init) => {
      requests++; const sent = JSON.parse(String(init?.body));
      return Response.json({ ok: true, device: sent.device, challenge: {
        setupReference: scope.setupReference, organizationId: scope.organizationId,
        recipientMembershipId: scope.recipientMembershipId, repositoryFingerprint: scope.repositoryFingerprint,
        scopeDigest: scope.scopeDigest, contractDigest: scope.contractDigest, policyRevision: scope.policyRevision,
        origin: scope.hqUrl, publicKeyEd25519: sent.publicKeyEd25519,
        credentialEncryptionPublicKey: sent.credentialEncryptionPublicKey, mode: 'source',
        schema: 'dharma.setup-claim-challenge/v1', method: 'POST', path: '/api/v1/agent-fabric/bootstrap/setup-claim',
        nonce: Buffer.alloc(32, 1).toString('base64url'), authenticator: Buffer.alloc(32, 2).toString('base64url'),
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60_000).toISOString(), ...changed,
      }});
    } }), /^Error: setup_claim_failed$/);
    assert.equal(requests, 1);
  }
});

async function fixture(change?: (payload: Record<string, unknown>) => void, pending = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-claim-synthetic-'));
  let time = Date.now(); let challenge: SetupClaimChallenge; let calls = 0; let stage = 'start';
  const secret = `dharma_org_${'s'.repeat(48)}`;
  const memory = store(); const server = generateKeyPairSync('ed25519');
  const publicKey = server.publicKey.export({format:'jwk'}).x!;
  const start = new Date(time-1_000).toISOString(), end = new Date(time+3_600_000).toISOString();
  const unsigned = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: scope.organizationId,
    generation: 1, keys: [{keyVersion: 'kms/1', publicKeyEd25519: publicKey, status: 'active' as const,
      notBefore: start, notAfter: end}], signedByKeyVersion: 'kms/1', issuedAt: start, expiresAt: end };
  const keyset: TrustedServerSigningKeyset = {...unsigned, signature: signCanonicalObject(unsigned, server.privateKey)};
  const fetcher: typeof fetch = async (_url, init) => {
    calls++; assert.equal(init?.redirect, 'error');
    const sent = JSON.parse(String(init?.body));
    assert.equal(String(init?.body).includes(secret), false);
    if (sent.action === 'challenge') {
      challenge = {schema:'dharma.setup-claim-challenge/v1', origin: scope.hqUrl,
        setupReference: scope.setupReference, organizationId: scope.organizationId,
        recipientMembershipId: scope.recipientMembershipId, publicKeyEd25519: sent.publicKeyEd25519,
        credentialEncryptionPublicKey: sent.credentialEncryptionPublicKey, repositoryFingerprint: scope.repositoryFingerprint,
        mode:'source', policyRevision:scope.policyRevision, scopeDigest:scope.scopeDigest, contractDigest:scope.contractDigest,
        method:'POST', path:'/api/v1/agent-fabric/bootstrap/setup-claim', nonce:Buffer.alloc(32,1).toString('base64url'),
        authenticator:Buffer.alloc(32,2).toString('base64url'), issuedAt:new Date(time).toISOString(),
        expiresAt:new Date(time+60_000).toISOString()};
      return Response.json({ok:true,challenge,device:sent.device});
    }
    stage = 'challenge-check'; assert.deepEqual(sent.challenge, challenge);
    stage = 'signature-check';
    assert.equal(verify(null, setupClaimSigningPayload(challenge), createPublicKey({format:'jwk',
      key:{kty:'OKP',crv:'Ed25519',x:challenge.publicKeyEd25519}}), Buffer.from(sent.signature,'base64url')), true);
    stage = 'signature-verified'; if (pending && calls === 2) {
      const expectedApproval = {
      url:`${scope.hqUrl}/portal/agent-fabric/setup-claim-approval#request=${Buffer.from(JSON.stringify({challenge,signature:sent.signature,device:sent.device})).toString('base64url')}`,
      expiresAt:challenge.expiresAt, repositoryFingerprint:challenge.repositoryFingerprint,
      fingerprint:`sha256:${createHash('sha256').update(Buffer.from(challenge.publicKeyEd25519,'base64url')).digest('hex')}`,
      };
      stage = 'approval-check'; parseSetupClaimRecipientApproval(expectedApproval,challenge,sent.signature,sent.device,time);
      stage = 'approval-verified';
      return Response.json({ok:false,status:'recipient_approval_required',approval:expectedApproval},{status:409});
    }
    const payload: Record<string,unknown> = {ok:true,status:'approved',organizationId:scope.organizationId,
      deviceId:'33333333-3333-4333-8333-333333333333',relayUrl:'wss://relay.example',serverPublicKeyEd25519:publicKey,
      serverSigningKeyset:keyset,organizationApiToken:secret,organizationApiTokenScopes:[
        'agents:read','agents:run','evals:read','evals:run','traces:read','skills:read','skills:write','usage:read','reports:read','fabric:devices','fabric:tasks'],
      setupReference:challenge.setupReference,recipientMembershipId:challenge.recipientMembershipId,
      publicKeyEd25519:challenge.publicKeyEd25519,repositoryFingerprint:challenge.repositoryFingerprint,
      scopeDigest:challenge.scopeDigest,contractDigest:challenge.contractDigest};
    change?.(payload);
    return Response.json({ok:true,status:'approved',credential:sealSetupClaimCredential(challenge, JSON.stringify(payload))});
  };
  return { root, secret, memory, get calls(){return calls;}, get stage(){return stage;},
    input:{...scope,configPath:resolve(root,'device.json'),store:memory,fetcher,now:()=>time,
      sleep:async(ms:number)=>{time+=ms;}}, advance:(ms:number)=>{time+=ms;} };
}
test('nonTTY claim signs exact approval request and stores credential without returning it', async () => {
  const f = await fixture(undefined,true); let approvals=0;
  try {
    const result = await claimSetupReference({...f.input,onRecipientApprovalRequired:approval=>{
      approvals++; assert.equal(approval.url.includes(f.secret),false);
    }}).catch(()=>{throw new Error(`synthetic_success_failed_requests_${f.calls}_approvals_${approvals}_${f.stage}`);});
    assert.equal(approvals,1); assert.equal(f.calls,3);
    assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),f.secret);
    assert.equal(JSON.stringify(result).includes(f.secret),false);
    assert.equal(result.config.setupClaimReference,scope.setupReference);
    assert.equal(result.config.setupClaimRepositoryFingerprint,scope.repositoryFingerprint);
    assert.deepEqual(setupClaimSourceRegistration(result.config,scope.repositoryFingerprint),{setupClaimReference:scope.setupReference});
    assert.deepEqual(setupClaimSourceRegistration(result.config,`sha256:${'d'.repeat(64)}`),{});
    assert.equal((await readFile(f.input.configPath,'utf8')).includes(f.secret),false);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
test('source dispatch is exact, grant-free and does not block legacy sibling repositories',()=>{
  const config={setupClaimReference:scope.setupReference,setupClaimRepositoryFingerprint:scope.repositoryFingerprint};
  assert.deepEqual(setupClaimSourceRegistration(config,scope.repositoryFingerprint),{setupClaimReference:scope.setupReference});
  assert.deepEqual(setupClaimSourceRegistration(config,`sha256:${'d'.repeat(64)}`),{});
  assert.deepEqual(setupClaimSourceRegistration({},scope.repositoryFingerprint),{});
  assert.throws(()=>setupClaimSourceRegistration({...config,setupClaimReference:'invalid'},scope.repositoryFingerprint),/^Error: setup_claim_failed$/);
});
test('sealed authority substitution and malformed scopes/token/trust never write enrollment', async t => {
  const mutations = [
    (p:Record<string,unknown>)=>{p.recipientMembershipId='44444444-4444-4444-8444-444444444444';},
    (p:Record<string,unknown>)=>{p.publicKeyEd25519=Buffer.alloc(32).toString('base64url');},
    (p:Record<string,unknown>)=>{p.scopeDigest=`sha256:${'d'.repeat(64)}`;},
    (p:Record<string,unknown>)=>{p.repositoryFingerprint=`sha256:${'d'.repeat(64)}`;},
    (p:Record<string,unknown>)=>{p.contractDigest=`sha256:${'d'.repeat(64)}`;},
    (p:Record<string,unknown>)=>{p.organizationApiTokenScopes=['fabric:devices','admin'];},
    (p:Record<string,unknown>)=>{p.organizationApiToken='secret-canary';},
    (p:Record<string,unknown>)=>{p.serverSigningKeyset=null;},
    (p:Record<string,unknown>)=>{(p.serverSigningKeyset as TrustedServerSigningKeyset).signature=Buffer.alloc(64).toString('base64url');},
  ];
  for (const [index, change] of mutations.entries()) await t.test(String(index),async()=>{
    const f=await fixture(change); try {
      await assert.rejects(claimSetupReference(f.input),/^Error: setup_claim_failed$/);
      assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
      await assert.rejects(readFile(f.input.configPath));
    } finally {await rm(f.root,{recursive:true,force:true});}
  });
});
test('expiry while recipient approval runs prevents another HTTP request/store write',async()=>{
  const f=await fixture(undefined,true); try {
    await assert.rejects(claimSetupReference({...f.input,onRecipientApprovalRequired:()=>f.advance(60_001)}),/^Error: setup_claim_failed$/);
    assert.equal(f.calls,2); assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('approval URL never allows another origin/path/query/signature/device context', async t=>{
  for(const field of ['origin','path','query','fingerprint','device'] as const) await t.test(field,async()=>{
    const f=await fixture(undefined,true); const fetcher:typeof fetch=async(url,init)=>{
      const response=await f.input.fetcher(url,init);
      if(response.status!==409)return response;
      const body=await response.json() as {approval:{url:string;fingerprint:string}};
      if(field==='origin')body.approval.url=body.approval.url.replace('hq.example','foreign.example');
      if(field==='path')body.approval.url=body.approval.url.replace('setup-claim-approval','bootstrap-approval');
      if(field==='query')body.approval.url=body.approval.url.replace('#','?redirect=foreign#');
      if(field==='fingerprint')body.approval.fingerprint=`sha256:${'0'.repeat(64)}`;
      if(field==='device'){
        const uri=new URL(body.approval.url); const value=JSON.parse(Buffer.from(uri.hash.slice(9),'base64url').toString());
        value.device.name='foreign';uri.hash=`request=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
        body.approval.url=uri.toString();
      }
      return Response.json(body,{status:409});
    };
    try{await assert.rejects(claimSetupReference({...f.input,fetcher}),/^Error: setup_claim_failed$/);
      assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
});
test('sealed ciphertext substitution and live response expiry do not commit credentials',async t=>{
  for(const field of ['tag','ephemeralPublicKey','expiresAt','clock'] as const)await t.test(field,async()=>{
    const f=await fixture();const fetcher:typeof fetch=async(url,init)=>{
      const response=await f.input.fetcher(url,init);
      const sent=JSON.parse(String(init?.body)); if(sent.action!=='finalize')return response;
      const body=await response.json() as {credential:SealedSetupClaimCredential};
      if(field==='clock')f.advance(60_001);
      else if(field==='expiresAt')body.credential.expiresAt='2030-01-01T00:00:00.000Z';
      else body.credential[field]=Buffer.alloc(field==='tag'?16:32).toString('base64url');
      return Response.json(body);
    };
    try{await assert.rejects(claimSetupReference({...f.input,fetcher}),/^Error: setup_claim_failed$/);
      assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
});
test('runtime requests and response envelopes agree with strict published schemas',async()=>{
  const f=await fixture(undefined,true);const schemas=resolve(import.meta.dirname,'../../../schemas');
  const fetcher:typeof fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-request/v1',request)).ok,true);
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-request/v1',{...request,grant:'forbidden'})).ok,false);
    const response=await f.input.fetcher(url,init);const body=await response.json() as Record<string,unknown>;
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-response/v1',body)).ok,true);
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-response/v1',{...body,organizationApiToken:'forbidden'})).ok,false);
    return Response.json(body,{status:response.status});
  };
  try{await claimSetupReference({...f.input,fetcher});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('lost response recovery uses the same protected device key with a fresh encrypted challenge',async()=>{
  const f=await fixture();let firstKey='';let lost=true;
  const fetcher:typeof fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(request.action==='challenge'){
      if(firstKey)assert.equal(request.publicKeyEd25519,firstKey);else firstKey=request.publicKeyEd25519;
    }
    const response=await f.input.fetcher(url,init);
    if(request.action==='finalize'&&lost){lost=false;throw new Error('synthetic-lost-response-secret-canary');}
    return response;
  };
  try{
    await assert.rejects(claimSetupReference({...f.input,fetcher}),/^Error: setup_claim_failed$/);
    assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    const result=await claimSetupReference({...f.input,fetcher});
    assert.equal(result.config.publicKeyEd25519,firstKey);
    assert.equal(JSON.stringify(result).includes(f.secret),false);
    assert.equal(f.calls,4);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
