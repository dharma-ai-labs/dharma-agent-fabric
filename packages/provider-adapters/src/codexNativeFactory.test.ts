import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { createNativeFactoryCapture, nativeFactoryCaptureSchema, nativeFactoryProviderSession, nativeFactoryCheckpoint, type NativeFactoryInput } from './codexNativeFactory.js';

const h = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
function event(x: Pick<NativeFactoryInput, 'events'>, index: number) {
  const value=x.events[index]; assert.ok(value); return value;
}
function fixture(): NativeFactoryInput {
  const at = '2026-10-17T23:06:34.000Z';
  return { factoryTaskId: 'factory-fixture-1',
    parentThreadId: 'parent-thread-1',
    parentTurnId: 'parent-turn-1',
    childThreadId: 'child-thread-1', organizationId: null,
    workspace: resolve('synthetic-factory'), instructionHash: h('review fixed source'),
    scope: { readPaths: ['src/service.ts'], writePaths: [], tools: ['read'], startedAt: at,
      expiresAt: '2026-10-17T23:30:00.000Z', maximumChildTurns: 2, maximumUsd: null },
    events: [ { eventId: 'spawn-1', kind: 'spawn', actor: 'parent', at, payloadHash: h('request') },
      { eventId: 'check-1', kind: 'checkpoint', actor: 'child', at, payloadHash: h('checkpoint') },
      { eventId: 'output-1', kind: 'output', actor: 'child', at, payloadHash: h('result') },
      { eventId: 'accept-1', kind: 'parent_acceptance', actor: 'parent', at, payloadHash: h('acceptance'),
        outputHash: h('result'), decision: 'accepted', integrationHash: h('tested integration') } ] };
}

test('maps one real-shaped child lifecycle into a partial, non-authorizing ProviderSession', () => {
  const input = fixture(), capture = createNativeFactoryCapture(input);
  assert.equal(capture.state, 'accepted');
  assert.equal(capture.fabricTaskId, null);
  assert.equal(capture.serverAcknowledgement, null);
  assert.equal(capture.acceptedLearningObservation, false);
  assert.equal(capture.budgetEnforcement, 'not_attested');
  const session = nativeFactoryProviderSession(capture);
  assert.equal(session.coverage, 'partial');
  assert.equal(session.records.length, 4);
  assert.equal(session.records[2]!.native.childThreadId, input.childThreadId);
  assert.equal(session.records[3]!.native.factoryTaskId, input.factoryTaskId);
  assert.ok(session.records.every(r => r.kind === 'metadata' && r.coverage === 'partial'));
  event(input,0).payloadHash = h('caller mutation');
  assert.notEqual(event(input,0).payloadHash, event(capture,0).payloadHash);
});

test('exact event replay is idempotent; reused identity with changed payload fails', () => {
  const input = fixture();
  input.events.splice(1, 0, structuredClone(event(input,0)));
  assert.equal(createNativeFactoryCapture(input).events.length, 4);
  event(input,1).payloadHash = h('different');
  assert.throws(() => createNativeFactoryCapture(input), /replay_conflict/);
});

test('recovery must reference an observed checkpoint on the same child', () => {
  const input = fixture();
  input.events.splice(2, 0, { eventId: 'resume-1', kind: 'recovery', actor: 'parent',
    at: event(input,1).at, payloadHash: h('same child resumed'), checkpointId: 'check-1' });
  assert.equal(createNativeFactoryCapture(input).events.length, 5);
  const recovery = event(input,2);
  if (recovery.kind !== 'recovery') throw Error('fixture');
  recovery.checkpointId = 'unknown';
  assert.throws(() => createNativeFactoryCapture(input), /recovery_checkpoint/);
});

for (const [name, mutate] of Object.entries({
  childEqualsParent: (x: NativeFactoryInput) => { x.childThreadId = x.parentThreadId; },
  childSpawns: (x: NativeFactoryInput) => { event(x,0).actor = 'child'; },
  beforeSpawn: (x: NativeFactoryInput) => { x.events.reverse(); },
  noOutput: (x: NativeFactoryInput) => { x.events.splice(2, 1); },
  wrongOutput: (x: NativeFactoryInput) => {
    const e=event(x,3); if(e.kind==='parent_acceptance') e.outputHash=h('foreign output'); },
  childAccepts: (x: NativeFactoryInput) => { event(x,3).actor='child'; },
  afterTerminal: (x: NativeFactoryInput) => { x.events.push({ ...event(x,1), eventId:'late' }); },
  expired: (x: NativeFactoryInput) => { x.scope.expiresAt='2026-10-17T23:00:00.000Z'; },
  reordered: (x: NativeFactoryInput) => { event(x,1).at='2026-10-17T23:06:33.000Z'; },
  oversized: (x: NativeFactoryInput) => { x.events=Array.from({length:129},()=>event(x,0)); },
})) test(`rejects ${name} without upgrading evidence`, () => {
  const input=fixture(); mutate(input); assert.throws(()=>createNativeFactoryCapture(input), /native_factory_/);
});

test('raw credentials, unknown authority fields and malformed hashes are rejected', () => {
  const input=fixture();
  for(const bad of [ { ...input, accessToken:'must-not-retain' },
    { ...input, fabricTaskId:'forged' }, { ...input, instructionHash:'not-a-hash' },
    { ...input, workspace:'password=not-for-evidence' } ]) {
    assert.throws(()=>createNativeFactoryCapture(bad), /native_factory_/);
  }
});

test('JSON encoded clientSecret cannot be retained in a scope path', () => {
  const input=fixture(); input.scope.readPaths=[JSON.stringify({clientSecret:'synthetic-secret-not-real'})];
  assert.throws(()=>createNativeFactoryCapture(input),/protected/);
});

test('UTF-8 byte limit rejects multibyte input below the character limit', () => {
  const input=fixture(); input.scope.readPaths=Array.from({length:24},()=>String.fromCodePoint(0x4e00).repeat(4096));
  assert.ok(JSON.stringify(input).length<256*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(input),'utf8')>256*1024);
  assert.throws(()=>createNativeFactoryCapture(input),/oversized/);
});

test('capture mutation is detected before conversion to provider records', () => {
  const capture=createNativeFactoryCapture(fixture()); event(capture,0).payloadHash=h('tamper');
  assert.throws(()=>nativeFactoryProviderSession(capture), /integrity/);
  const metadata=createNativeFactoryCapture(fixture()); metadata.state='rejected';
  assert.throws(()=>nativeFactoryProviderSession(metadata), /integrity/);
});

test('acceptance without integration is distinct; checkpoints reject scope and history substitution', () => {
  const input=fixture(), accept=event(input,3);
  if(accept.kind!=='parent_acceptance') throw Error('fixture');
  accept.integrationHash=null;
  const capture=createNativeFactoryCapture(input);
  assert.equal(capture.state,'accepted'); assert.equal(capture.integrationState,'not_reported');
  const prefix=createNativeFactoryCapture({...input,events:input.events.slice(0,2)});
  const checkpoint=nativeFactoryCheckpoint(prefix);
  assert.deepEqual(createNativeFactoryCapture(input,checkpoint),capture);
  for(const key of ['factoryTaskId','parentThreadId','parentTurnId','childThreadId','workspace','instructionHash'] as const) {
    const modified=structuredClone(input);
    modified[key]=key==='instructionHash'?h('different reviewed instructions'):modified[key]+'x';
    assert.throws(()=>createNativeFactoryCapture(modified,checkpoint),/checkpoint_conflict/);
  }
  const changed=structuredClone(input); event(changed,1).payloadHash=h('rewritten checkpoint');
  assert.throws(()=>createNativeFactoryCapture(changed,checkpoint),/checkpoint_conflict/);
  assert.deepEqual(nativeFactoryProviderSession(capture),nativeFactoryProviderSession(createNativeFactoryCapture(input)));
});

test('expiry is half-open and recovery never extends the original scope', () => {
  const input=fixture(); event(input,3).at=input.scope.expiresAt;
  assert.throws(()=>createNativeFactoryCapture(input),/event_time/);
  event(input,3).at='2026-10-17T23:29:59.999Z';
  assert.equal(createNativeFactoryCapture(input).state,'accepted');
});

test('both platform path forms are accepted; relative workspace and implicit budget are not', () => {
  for(const workspace of ['/repo/synthetic','C:\\repo\\synthetic']) {
    assert.equal(createNativeFactoryCapture({...fixture(),workspace}).workspace,workspace);
  }
  assert.throws(()=>createNativeFactoryCapture({...fixture(),workspace:'relative'}),/workspace/);
  const input: unknown={...fixture(),scope:{...fixture().scope,maximumUsd:undefined}};
  assert.throws(()=>createNativeFactoryCapture(input),/invalid/);
});

test('schema validates the same partial capture and forbids invented signed or learning status', async () => {
  const capture=createNativeFactoryCapture(fixture());
  const root=resolve(import.meta.dirname,'../../../schemas');
  const schema='https://schemas.dharma-ai.io/codex-native-factory-capture/v1';
  const saved=JSON.parse(await readFile(resolve(root,'codex-native-factory-capture-v1.schema.json'),'utf8'));
  assert.deepEqual(saved,{...z.toJSONSchema(nativeFactoryCaptureSchema),$id:schema});
  assert.equal((await validateContract(root,schema,capture)).ok,true);
  for(const invalid of [{...capture,acceptedLearningObservation:true},{...capture,fabricTaskId:'forged'}]) {
    assert.equal((await validateContract(root,schema,invalid)).ok,false);
  }
});
