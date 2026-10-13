import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {canonicalize, validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {captureCodexSetupPromptBinding, captureCodexSetupUserPrompt, capturePublicCodexSetupPrompt} from './codexSetupUserPrompt.js';
import type {CodexSetupIntent} from './codexSetupAdmission.js';

interface Preparation {
  schema: 'dharma.setup-host-preparation/v1'; ok: true; effects: false; grantRedeemed: false;
  approvalRequired: true; sourcePolicyRevalidated: true; preparedAt: string; expiresAt: string;
  promptSha256: string; cliVersion: string;
  integrity: {algorithm: 'sha256'; kind: 'portal-context'; authenticity: 'same-origin-https'; contextSha256: string};
  binding: {recipientEmail: string; repositoryRemoteUrl: string};
  context: Pick<CodexSetupIntent, 'origin' | 'organizationId' | 'setupReference' | 'recipientMembershipId'
    | 'repositoryFingerprint' | 'policyRevision' | 'scopeDigest' | 'contractDigest'>;
}
const fail = (): never => {throw new Error('codex_setup_portal_preparation_unavailable');};

/** A public HTTPS receipt is presentation binding, not a host execution lease. */
export async function requestCodexSetupHostPreparation(input: {
  origin: string; organizationId: string; setupReference: string; cliVersion: string;
  initialUserPrompt: unknown; signal: AbortSignal; fetcher?: typeof fetch; now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  // Capture before awaiting: no secret-bearing prose may reach the endpoint.
  const initialUserPrompt = capturePublicCodexSetupPrompt(input.initialUserPrompt);
  const pins = [...initialUserPrompt.replace(/\r\n/g, '\n').matchAll(/^Preparation context SHA256: ([a-f0-9]{64})\.$/gm)];
  if (pins.length !== 1) return fail();
  const originalContextPin = pins[0]![1]!;
  const {origin, organizationId, setupReference, cliVersion} = input;
  const initialUserPromptSha256 = createHash('sha256').update(initialUserPrompt, 'utf8').digest('hex');
  const promptSha256 = createHash('sha256').update(initialUserPrompt.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const now = input.now ?? Date.now;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {void reader?.cancel().catch(() => {});};
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password
      || !/^org_[A-Za-z0-9]+$/.test(organizationId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(setupReference)
      || !/^\d+\.\d+\.\d+$/.test(cliVersion) || signal.aborted) return fail();
    const response = await (input.fetcher ?? fetch)(origin + '/api/v1/agent-fabric/bootstrap/setup-claim', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'prepare_host', organizationId, setupReference, promptSha256}),
    });
    if (signal.aborted || response.status !== 200 || !response.body
      || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      || Number(response.headers.get('content-length')) > 65536) return fail();
    reader = response.body.getReader(); signal.addEventListener('abort', cancel, {once: true});
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      if (signal.aborted) return fail();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) {await reader.cancel(); return fail();}
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const checked = await validateContract(resolve(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/setup-host-preparation/v1', value);
    if (!checked.ok || signal.aborted) return fail();
    const prepared = value as Preparation, at = now();
    const contextSha256 = createHash('sha256').update('dharma.setup-host-context/v1\0').update(canonicalize({
      cliVersion: prepared.cliVersion, expiresAt: prepared.expiresAt, binding: prepared.binding, context: prepared.context})).digest('hex');
    if (contextSha256 !== originalContextPin || prepared.integrity.contextSha256 !== originalContextPin) return fail();
    const issued = Date.parse(prepared.preparedAt), expires = Date.parse(prepared.expiresAt);
    if (prepared.context.origin !== origin || prepared.context.organizationId !== organizationId
      || prepared.context.setupReference !== setupReference || prepared.cliVersion !== cliVersion
      || prepared.promptSha256 !== promptSha256 || !Number.isFinite(at)
      || new Date(issued).toISOString() !== prepared.preparedAt
      || new Date(expires).toISOString() !== prepared.expiresAt
      || issued - at > 5000 || expires <= at || expires <= issued || expires - issued > 900000) return fail();
    const binding = captureCodexSetupPromptBinding(prepared.binding);
    const intent: Readonly<CodexSetupIntent> = Object.freeze({
      schema: 'dharma.codex-setup-intent/v1', ...prepared.context,
      operationId: randomUUID(), hostContextId: randomUUID(),
      issuedAt: prepared.preparedAt, expiresAt: prepared.expiresAt,
    });
    if (captureCodexSetupUserPrompt(initialUserPrompt, intent, binding) !== initialUserPrompt) return fail();
    // Match the claim client's bounded skew wait; never change the local clock
    // or admit effects before the response's strict issued-at boundary.
    if (issued > at) await (input.sleep ?? ((ms, ownedSignal) => delay(ms, undefined, {signal: ownedSignal})))(issued - at, signal);
    const currentTime = now();
    if (signal.aborted || !Number.isFinite(currentTime) || currentTime < issued || currentTime >= expires) return fail();
    // No provider, key store, setup journal or enrollment operation is entered.
    return Object.freeze({effects: false as const, grantRedeemed: false as const,
      initialUserPrompt, initialUserPromptSha256, promptSha256, portalContextSha256: originalContextPin, binding, intent,
      requiresHostExecutionAdmission: true as const, requiresRecipientApproval: true as const});
  } catch {return fail();}
  finally {signal.removeEventListener('abort', cancel); reader?.releaseLock();}
}
