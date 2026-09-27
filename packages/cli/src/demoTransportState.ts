import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, sha256, validateTrustedServerSigningKeysetContract,
  verifyInitialServerSigningKeyset, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { verifyDemoTransportContinuity, type DemoTransportContinuity,
  type DemoTransportContinuityContext } from './demoTransportContinuity.js';

export type DemoTransportBinding = Omit<DemoTransportContinuityContext,
  'transportOrigin' | 'requestNonce' | 'previous' | 'now'>;
type Expected = { transportOrigin: string; requestNonce: string };
type Dependencies = { store: SecureSecretStore; now?: () => Date };
interface State {
  schema: 'dharma.demo-transport-state/v1'; certificate: DemoTransportContinuity;
  verifiedKeyset: TrustedServerSigningKeyset; acceptedAt: string;
}
interface Journal {
  schema: 'dharma.demo-transport-journal/v1'; previousState: string | null;
  previousStateHash: string; nextState: string;
}
export type DemoTransportResolution =
  | { state: 'original'; transportOrigin: string }
  | { state: 'ready'; transportOrigin: string; certificate: DemoTransportContinuity }
  | { state: 'refresh_required'; lastTransportOrigin: string; policyRevision: number };

let validators: Promise<{ state: ValidateFunction<State>; journal: ValidateFunction<Journal> }> | undefined;
function runtimeValidators() {
  return validators ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;
    addFormats(ajv);
    for (const name of ['server-signing-keyset', 'demo-transport-continuity', 'demo-transport-state', 'demo-transport-journal']) {
      ajv.addSchema(JSON.parse(await readFile(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    }
    return { state: ajv.getSchema<State>('https://schemas.dharma-ai.io/demo-transport-state/v1')!,
      journal: ajv.getSchema<Journal>('https://schemas.dharma-ai.io/demo-transport-journal/v1')! };
  })();
}
function fail(reason: string): never { throw new Error(`Demo transport state rejected: ${reason}. Preserve enrollment and pending transport recovery.`); }
function clock(deps: Dependencies) {
  const now = deps.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('clock_invalid');
  return now;
}
function accountFor(binding: DemoTransportBinding) {
  const identity = { organizationId: binding.organizationId, repositoryId: binding.repositoryId,
    deviceId: binding.deviceId, installationId: binding.installationId,
    publicKeyEd25519: binding.publicKeyEd25519, enrollmentOrigin: binding.enrollmentOrigin };
  return `demo-transport-${sha256(canonicalize(identity)).slice(7)}`;
}
function assertHead(binding: DemoTransportBinding, now: Date) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let origin: URL;
  try { origin = new URL(binding.enrollmentOrigin); } catch { fail('binding_invalid'); }
  if (typeof binding.organizationId !== 'string' || binding.organizationId.length > 200
    || !/^org_[A-Za-z0-9]+$/.test(binding.organizationId)
    || ![binding.repositoryId, binding.deviceId, binding.installationId]
      .every(value => typeof value === 'string' && uuid.test(value))
    || typeof binding.publicKeyEd25519 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding.publicKeyEd25519)
    || origin.protocol !== 'https:' || origin.origin !== binding.enrollmentOrigin) fail('binding_invalid');
  const keyset = binding.protectedKeyset;
  if (!Number.isSafeInteger(binding.minimumPolicyRevision) || binding.minimumPolicyRevision < 1
    || !validateTrustedServerSigningKeysetContract(keyset).ok) fail('protected_authority_invalid');
  const signer = keyset.keys.find(key => key.keyVersion === keyset.signedByKeyVersion);
  if (!signer || signer.status !== 'active' || keyset.keys.filter(key => key.status === 'active').length !== 1
    || !/^[A-Za-z0-9_-]{43}$/.test(signer.publicKeyEd25519)
    || Date.parse(signer.notBefore) > now.getTime() || Date.parse(signer.notAfter) < Date.parse(keyset.expiresAt)) {
    fail('protected_authority_invalid');
  }
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: signer.publicKeyEd25519 } });
  if (!verifyInitialServerSigningKeyset(keyset, key, binding.organizationId, now).ok) fail('protected_authority_invalid');
}
async function fresh(store: SecureSecretStore, account: string) {
  try { return await (store.getFresh ? store.getFresh(account) : store.get(account)); }
  catch { fail('secure_store_read_failed'); }
}
async function confirmedPut(store: SecureSecretStore, account: string, value: string) {
  try { await store.put(account, value); }
  catch { fail('secure_store_write_failed'); }
  if (await fresh(store, account) !== value) fail('secure_store_write_unconfirmed');
}
function parse(value: string, kind: 'state' | 'journal') {
  if (Buffer.byteLength(value) > (kind === 'state' ? 65_536 : 140_000)) fail(`${kind}_invalid`);
  let record: unknown;
  try { record = JSON.parse(value); } catch { fail(`${kind}_invalid`); }
  if (canonicalize(record) !== value) fail(`${kind}_invalid`);
  return record;
}
async function verifiedState(raw: string, binding: DemoTransportBinding, now: Date): Promise<State> {
  const state = parse(raw, 'state');
  if (!(await runtimeValidators()).state(state)) fail('state_invalid');
  const accepted = new Date(state.acceptedAt);
  if (accepted.getTime() > now.getTime()) fail('state_invalid');
  await verifyDemoTransportContinuity(state.certificate, { ...binding, minimumPolicyRevision: 1,
    protectedKeyset: state.verifiedKeyset, transportOrigin: state.certificate.transportOrigin,
    requestNonce: state.certificate.requestNonce, now: accepted });
  if (state.verifiedKeyset.generation > binding.protectedKeyset.generation) fail('protected_generation_rollback');
  if (state.verifiedKeyset.generation === binding.protectedKeyset.generation
    && canonicalize(state.verifiedKeyset) !== canonicalize(binding.protectedKeyset)) fail('protected_generation_conflict');
  return state;
}
function assertTransition(previous: State | null, next: State) {
  if (!previous) return;
  if (next.certificate.policyRevision < previous.certificate.policyRevision
    || (next.certificate.policyRevision === previous.certificate.policyRevision
      && next.certificate.transportOrigin !== previous.certificate.transportOrigin)) fail('policy_revision_conflict');
  if (next.verifiedKeyset.generation < previous.verifiedKeyset.generation) fail('protected_generation_rollback');
  if (next.verifiedKeyset.generation === previous.verifiedKeyset.generation
    && canonicalize(next.verifiedKeyset) !== canonicalize(previous.verifiedKeyset)) fail('protected_generation_conflict');
}
async function clearJournal(store: SecureSecretStore, account: string) {
  try { await store.delete(`${account}-journal`); }
  catch { fail('secure_store_write_failed'); }
  if (await fresh(store, `${account}-journal`) !== null) fail('secure_store_write_unconfirmed');
}

// Call under the existing device-operation lock. Only this independent transport
// account is written; protected signing history and device keys are never moved.
async function restoredState(binding: DemoTransportBinding, deps: Dependencies) {
  assertHead(binding, clock(deps));
  const account = accountFor(binding), store = deps.store;
  const pending = await fresh(store, `${account}-journal`);
  let current = await fresh(store, account);
  if (pending !== null) {
    const journal = parse(pending, 'journal');
    if (!(await runtimeValidators()).journal(journal)
      || journal.previousStateHash !== sha256(journal.previousState ?? '')) fail('journal_invalid');
    if (current !== null && current !== journal.previousState && current !== journal.nextState) fail('journal_conflict');
    const previous = journal.previousState === null ? null : await verifiedState(journal.previousState, binding, clock(deps));
    const next = await verifiedState(journal.nextState, binding, clock(deps));
    assertTransition(previous, next);
    if (await fresh(store, `${account}-journal`) !== pending) fail('journal_conflict');
    const rechecked = await fresh(store, account);
    if (rechecked !== current) fail('journal_conflict');
    if (current !== journal.nextState) await confirmedPut(store, account, journal.nextState);
    await clearJournal(store, account);
    current = journal.nextState;
  }
  return { account, raw: current, state: current === null ? null : await verifiedState(current, binding, clock(deps)) };
}

export async function resolveDemoTransport(input: DemoTransportBinding, deps: Dependencies): Promise<DemoTransportResolution> {
  const binding = structuredClone(input);
  const { state } = await restoredState(binding, deps);
  assertHead(binding, clock(deps));
  if (!state) return { state: 'original', transportOrigin: binding.enrollmentOrigin };
  if (state.verifiedKeyset.generation !== binding.protectedKeyset.generation
    || state.certificate.policyRevision < binding.minimumPolicyRevision
    || Date.parse(state.certificate.expiresAt) <= clock(deps).getTime()) {
    return { state: 'refresh_required', lastTransportOrigin: state.certificate.transportOrigin,
      policyRevision: state.certificate.policyRevision };
  }
  await verifyDemoTransportContinuity(state.certificate, { ...binding,
    transportOrigin: state.certificate.transportOrigin, requestNonce: state.certificate.requestNonce, now: clock(deps) });
  return { state: 'ready', transportOrigin: state.certificate.transportOrigin, certificate: state.certificate };
}

export async function acceptDemoTransport(value: unknown, input: DemoTransportBinding,
  expectedInput: Expected, deps: Dependencies) {
  const binding = structuredClone(input), candidate = structuredClone(value), expected = structuredClone(expectedInput);
  const original = await restoredState(binding, deps);
  const certificate = await verifyDemoTransportContinuity(candidate, { ...binding, ...expected, now: clock(deps),
    ...(original.state ? { previous: original.state.certificate } : {}) });
  if (original.state && canonicalize(certificate) === canonicalize(original.state.certificate)) {
    return { state: 'ready' as const, certificate, duplicate: true };
  }
  const state: State = { schema: 'dharma.demo-transport-state/v1', certificate,
    verifiedKeyset: binding.protectedKeyset, acceptedAt: clock(deps).toISOString() };
  const nextState = canonicalize(state);
  const next = await verifiedState(nextState, binding, clock(deps));
  assertTransition(original.state, next);
  const store = deps.store, account = original.account;
  if (await fresh(store, account) !== original.raw || await fresh(store, `${account}-journal`) !== null) fail('journal_conflict');
  const journal = canonicalize({ schema: 'dharma.demo-transport-journal/v1',
    previousState: original.raw, previousStateHash: sha256(original.raw ?? ''), nextState });
  await confirmedPut(store, `${account}-journal`, journal);
  await restoredState(binding, deps);
  assertHead(binding, clock(deps));
  await verifyDemoTransportContinuity(certificate, { ...binding, ...expected, now: clock(deps) });
  return { state: 'ready' as const, certificate, duplicate: false };
}
