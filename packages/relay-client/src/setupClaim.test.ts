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
test('claim failures expose only the locally observed phase, never vendor content', async () => {
  const identityStore = store(); const get = identityStore.get;
  identityStore.get = async key => {
    if (key.startsWith('setup-claim-preflight-')) return get.call(identityStore, key);
    throw new Error('secret-canary');
  };
  const cases: Array<{phase: string; store: SecureSecretStore; input?: Partial<typeof scope>}> = [
    {phase: 'input_validation', store: store(), input: {setupReference: 'invalid'}},
    {phase: 'store_preflight', store: {...store(), put: async () => { throw new Error('secret-canary'); }}},
    {phase: 'identity', store: identityStore},
    {phase: 'challenge', store: store()},
  ];
  for (const value of cases) {
    const reports: unknown[] = []; let requests = 0;
    const onFailureDiagnostic = (report: unknown) => { reports.push(report); assert.equal(Object.isFrozen(report), true); };
    await assert.rejects(claimSetupReference({...scope, ...value.input, store: value.store,
      ...{onFailureDiagnostic}, fetcher: async () => { requests++; throw new Error('secret-canary'); }}),
    /^Error: setup_claim_failed$/);
    assert.deepEqual(reports, [{schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase: value.phase}]);
    assert.equal(JSON.stringify(reports).includes('secret-canary'), false);
    assert.equal(requests, value.phase === 'challenge' ? 1 : 0);
  }
});

test('diagnostic observer failure cannot replace the sanitized claim failure', async () => {
  let observations = 0;
  const onFailureDiagnostic = () => { observations++; throw new Error('observer-secret-canary'); };
  await assert.rejects(claimSetupReference({...scope, setupReference: 'invalid', ...{onFailureDiagnostic}}),
    /^Error: setup_claim_failed$/);
  assert.equal(observations, 1);
});

test('asynchronous diagnostic rejection cannot escape as an unhandled vendor error', async () => {
  const onFailureDiagnostic = async () => { throw new Error('observer-secret-canary'); };
  await assert.rejects(claimSetupReference({...scope, setupReference: 'invalid', ...{onFailureDiagnostic}}),
    /^Error: setup_claim_failed$/);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('phase diagnostic schema rejects private fields and unbounded error classifications', async () => {
  const schemaDir = resolve(import.meta.dirname, '../../../schemas');
  const schemaId = 'https://schemas.dharma-ai.io/setup-claim-failure/v1';
  const report = {schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase: 'store_preflight'};
  const phases = ['input_validation', 'store_preflight', 'identity', 'challenge', 'signing', 'finalize',
    'recipient_approval', 'credential_validation', 'credential_commit'];
  for (const phase of phases) assert.equal((await validateContract(schemaDir, schemaId, {...report, phase})).ok, true);
  for (const extra of [{message: 'secret-canary'}, {exception: 'secret-canary'}, {response: {token: 'secret-canary'}},
    {phase: 'secret-canary'}, {code: 'safe_to_retry'}, {status: 'ready'}, {schema: 'foreign'}]) {
    assert.equal((await validateContract(schemaDir, schemaId, {...report, ...extra})).ok, false);
  }
});
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

async function fixture(change?: (payload: Record<string, unknown>) => void, pending = false, issuedAheadMs = 0) {
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
        authenticator:Buffer.alloc(32,2).toString('base64url'), issuedAt:new Date(time+issuedAheadMs).toISOString(),
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

test('post-challenge failures report finalize, approval, validation and commit distinctly', async t => {
  for (const phase of ['finalize', 'recipient_approval', 'credential_validation', 'credential_commit']) {
    await t.test(phase, async () => {
      const f = await fixture(phase === 'credential_validation' ? payload => { payload.organizationApiToken = 'secret-canary'; }
        : undefined, phase === 'recipient_approval');
      const reports: unknown[] = []; const originalFetch = f.input.fetcher;
      if (phase === 'credential_commit') {
        const put = f.memory.put;
        f.memory.put = async (key, value) => {
          if (key.startsWith('organization-api-')) throw new Error('secret-canary');
          return put.call(f.memory, key, value);
        };
      }
      const onFailureDiagnostic = (report: unknown) => { reports.push(report); };
      try {
        await assert.rejects(claimSetupReference({...f.input, ...{onFailureDiagnostic},
          fetcher: async (url, init) => {
            if (phase === 'finalize' && JSON.parse(String(init?.body)).action === 'finalize') throw new Error('secret-canary');
            return originalFetch(url, init);
          }, onRecipientApprovalRequired: () => { throw new Error('secret-canary'); }}), /^Error: setup_claim_failed$/);
        assert.deepEqual(reports, [{schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase}]);
        assert.equal(JSON.stringify(reports).includes(f.secret), false);
        assert.equal(JSON.stringify(reports).includes('secret-canary'), false);
        await assert.rejects(readFile(f.input.configPath), {code: 'ENOENT'});
      } finally { await rm(f.root, {recursive: true, force: true}); }
    });
  }
});

test('successful setup emits no failure diagnostic', async () => {
  const f = await fixture(); let observations = 0;
  const onFailureDiagnostic = () => { observations++; };
  try {
    const result = await claimSetupReference({...f.input, ...{onFailureDiagnostic}});
    assert.equal(result.config.setupClaimReference, scope.setupReference);
    assert.equal(observations, 0);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});
test('small server clock lead waits for strict time validity before approval or finalize', async t => {
  for (const lead of [2208, 5000]) await t.test(`lead_${lead}ms`, async () => {
    const f = await fixture(undefined, true, lead); const waits: number[] = [];
    try {
      const result = await claimSetupReference({...f.input, sleep: async ms => { waits.push(ms); f.advance(ms); }});
      assert.equal(waits[0], lead);
      assert.equal(result.config.setupClaimReference, scope.setupReference);
      assert.equal(f.calls, 3);
    } finally { await rm(f.root,{recursive:true,force:true}); }
  });
});
test('future challenge never weakens scope, expiry, maximum wait or a stalled local clock', async t => {
  for (const kind of ['excessive_lead', 'deadline', 'stalled_clock', 'expiry', 'wrong_scope'] as const) {
    await t.test(kind, async () => {
      const f = await fixture(undefined, false, kind === 'excessive_lead' ? 5001 : 2208);
      let waits = 0;
      const fetcher: typeof fetch = async (url, init) => {
        const response = await f.input.fetcher(url, init);
        if (kind !== 'wrong_scope') return response;
        const body = await response.json() as {challenge: Record<string, unknown>};
        body.challenge.scopeDigest = `sha256:${'d'.repeat(64)}`;
        return Response.json(body);
      };
      try {
        await assert.rejects(claimSetupReference({...f.input, fetcher,
          maximumWaitMs: kind === 'deadline' ? 2000 : 900_000,
          sleep: async ms => { waits++; if (kind !== 'stalled_clock') f.advance(kind === 'expiry' ? 60_001 : ms); },
        }), /^Error: setup_claim_failed$/);
        assert.equal(f.calls, 1);
        assert.equal(waits, ['stalled_clock','expiry'].includes(kind) ? 1 : 0);
        await assert.rejects(readFile(f.input.configPath), {code:'ENOENT'});
        assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}), null);
      } finally { await rm(f.root,{recursive:true,force:true}); }
    });
  }
});
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

test('claim name boundary rejects 121 characters and short/control names before store or HTTP effects',async()=>{
  for(const name of ['a'.repeat(121),'a','a\n']){
    let effects=0;const forbidden:SecureSecretStore={backend:'linux-secret-service',
      get:async()=>{effects++;return null;},put:async()=>{effects++;},delete:async()=>{effects++;}};
    await assert.rejects(claimSetupReference({...scope,name,store:forbidden,fetcher:async()=>{
      effects++;return Response.json({});
    }}),/^Error: setup_claim_failed$/);
    assert.equal(effects,0);
  }
});
test('claim name boundary permits 120 characters and request schema agrees',async()=>{
  const f=await fixture();const name='a'.repeat(120);
  const fetcher:typeof fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(request.action==='challenge'){
      const schemas=resolve(import.meta.dirname,'../../../schemas');
      assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-request/v1',request)).ok,true);
      assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/setup-claim-request/v1',{
        ...request,device:{...request.device,name:'a'.repeat(121)}})).ok,false);
    }
    return f.input.fetcher(url,init);
  };
  try{const result=await claimSetupReference({...f.input,name,fetcher});assert.equal(result.config.deviceName,name);}
  finally{await rm(f.root,{recursive:true,force:true});}
});
test('approved rate limit retries exact signed request with Retry-After and preserves request timeout',async()=>{
  const f=await fixture();const finalized:string[]=[];let limited=true;const waits:number[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    assert.ok(init?.signal);
    if(request.action==='finalize'){
      finalized.push(String(init?.body));
      if(limited){limited=false;return Response.json({ok:false,error:{code:'rate_limited',message:'secret-canary'}},
        {status:429,headers:{'retry-after':'1'}});}
    }
    return f.input.fetcher(url,init);
  };
  try{
    const result=await claimSetupReference({...f.input,fetcher,sleep:async ms=>{waits.push(ms);f.advance(ms);}});
    assert.equal(result.config.setupClaimReference,scope.setupReference);
    assert.equal(finalized.length,2);assert.equal(finalized[0],finalized[1]);
    assert.deepEqual(waits,[1_000]);assert.equal(f.calls,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('rate limit retry cannot exceed fixed expiry or accept malformed Retry-After/error context',async t=>{
  for(const kind of ['deadline','missing','malformed','wrong-code'] as const)await t.test(kind,async()=>{
    const f=await fixture();let finalized=0,waits=0;
    const fetcher:typeof fetch=async(url,init)=>{
      const request=JSON.parse(String(init?.body));
      if(request.action==='finalize'){
        finalized++;return Response.json({ok:false,error:{code:kind==='wrong-code'?'foreign':'rate_limited'}},
          {status:429,headers:kind==='missing'?{}:{'retry-after':kind==='deadline'?'60':kind==='malformed'?'invalid':'1'}});
      }
      return f.input.fetcher(url,init);
    };
    try{
      await assert.rejects(claimSetupReference({...f.input,fetcher,sleep:async()=>{waits++;}}),/^Error: setup_claim_failed$/);
      assert.equal(finalized,1);assert.equal(waits,0);
      assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
});
test('repeated approved rate limits stop at overall deadline without new challenge or proof',async()=>{
  const f=await fixture();const finalized:string[]=[];const waits:number[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));if(request.action!=='finalize')return f.input.fetcher(url,init);
    finalized.push(String(init?.body));return Response.json({ok:false,error:{code:'rate_limited'}},
      {status:429,headers:{'retry-after':'1'}});
  };
  try{
    await assert.rejects(claimSetupReference({...f.input,fetcher,maximumWaitMs:2_500,
      sleep:async ms=>{waits.push(ms);f.advance(ms);}}),/^Error: setup_claim_failed$/);
    assert.deepEqual(waits,[1_000,1_000]);assert.equal(finalized.length,3);
    assert.equal(new Set(finalized).size,1);assert.equal(f.calls,1);
    assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('relay normalization never returns or persists an untrusted path canary',async()=>{
  const canary='synthetic-relay-path-canary';const f=await fixture(p=>{p.relayUrl=`wss://relay.example/${canary}`;});
  try{
    const result=await claimSetupReference(f.input);
    assert.equal(result.config.relayUrl,'wss://relay.example');
    assert.equal(JSON.stringify(result).includes(canary),false);
    assert.equal((await readFile(f.input.configPath,'utf8')).includes(canary),false);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('relay query or userinfo secrets are rejected without public output or credential commit',async t=>{
  for(const relayUrl of ['wss://relay.example/?token=synthetic-canary','wss://synthetic-canary@relay.example'])
    await t.test('invalid relay authority',async()=>{
      const f=await fixture(p=>{p.relayUrl=relayUrl;});
      try{await assert.rejects(claimSetupReference(f.input),/^Error: setup_claim_failed$/);
        assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);}
      finally{await rm(f.root,{recursive:true,force:true});}
    });
});
test('protected device key changes after approval cannot commit enrollment credentials',async()=>{
  const f=await fixture();const currentGet=f.memory.get;
  f.memory.getFresh=async account=>account.startsWith('device-key-')?null:currentGet(account);
  try{
    await assert.rejects(claimSetupReference(f.input),/^Error: setup_claim_failed$/);
    assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    await assert.rejects(readFile(f.input.configPath));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('expiry during protected token write stops later anchor/config publication without destructive rollback',async()=>{
  const f=await fixture();const put=f.memory.put;let anchors=0;
  f.memory.put=async(account,value)=>{
    await put(account,value);
    if(account.startsWith('organization-api-'))f.advance(60_001);
    if(account.startsWith('device-enrollment-'))anchors++;
  };
  try{
    await assert.rejects(claimSetupReference(f.input),/^Error: setup_claim_failed$/);
    assert.equal(anchors,0);await assert.rejects(readFile(f.input.configPath));
    // The already-written protected credential is preserved for authenticated
    // same-key recovery; no claim of transactional native-store rollback.
    assert.equal(Boolean(await loadOrganizationApiToken({...scope,store:f.memory})),true);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('protected token write interruption is sanitized and cannot publish a device config',async()=>{
  const f=await fixture();const put=f.memory.put;let anchors=0;
  f.memory.put=async(account,value)=>{
    if(account.startsWith('organization-api-'))throw new Error('synthetic-secret-interruption');
    if(account.startsWith('device-enrollment-'))anchors++;
    await put(account,value);
  };
  try{
    await assert.rejects(claimSetupReference(f.input),/^Error: setup_claim_failed$/);
    assert.equal(anchors,0);await assert.rejects(readFile(f.input.configPath));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('recipient approval cancellation stops without credential writes or a public config',async()=>{
  const f=await fixture(undefined,true);
  try{
    await assert.rejects(claimSetupReference({...f.input,onRecipientApprovalRequired:()=>{
      throw new Error('synthetic-private-cancellation');
    }}),/^Error: setup_claim_failed$/);
    assert.equal(await loadOrganizationApiToken({...scope,store:f.memory}),null);
    await assert.rejects(readFile(f.input.configPath));assert.equal(f.calls,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
