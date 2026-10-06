import {types} from 'node:util';
import type {ChildProcess} from 'node:child_process';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import type {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {parseLocalCodexSetupSessionRequest, type LocalCodexSetupSessionRequest}
  from '@dharma-ai-labs/agent-fabric-local-vault/setup-session';
import type {AcceptedSetupSessionScope} from './codexSetupSessionHandoff.js';
import type {NamedSessionChildOwner} from './namedSessionChildOwner.js';

export interface CodexSetupChildMessage {
  schema: 'dharma.codex-setup-child-start/v1'; operationId: string; intentDigest: string;
}
function parse(value: unknown): Readonly<CodexSetupChildMessage> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new Error('setup_child_unavailable');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['schema', 'operationId', 'intentDigest'].includes(key)
    || !Object.hasOwn(fields[key]!, 'value') || !fields[key]!.enumerable)) throw new Error('setup_child_unavailable');
  const schema = fields.schema!.value, operationId = fields.operationId!.value, intentDigest = fields.intentDigest!.value;
  if (schema !== 'dharma.codex-setup-child-start/v1' || typeof operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(operationId)
    || typeof intentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(intentDigest)) throw new Error('setup_child_unavailable');
  return Object.freeze({schema, operationId, intentDigest});
}

/** Only the standing owner's captured fresh child handle receives public IDs.
 * The IPC message itself grants nothing; the child verifies encrypted state. */
export async function sendCodexSetupChildStart(input: {owner: NamedSessionChildOwner; child: ChildProcess;
  scope: AcceptedSetupSessionScope}) {
  input.owner.assertCaptured(input.scope.request.name, input.child);
  if (input.owner.ownedPid(input.scope.request.name) !== input.child.pid || !input.child.connected || !input.child.send) {
    throw new Error('setup_child_unavailable');
  }
  const message = parse({schema: 'dharma.codex-setup-child-start/v1', operationId: input.scope.request.operationId,
    intentDigest: input.scope.request.intentDigest});
  await input.scope.step(() => new Promise<void>((done, fail) => {
    input.owner.assertCaptured(input.scope.request.name, input.child);
    if (input.owner.ownedPid(input.scope.request.name) !== input.child.pid || !input.child.connected) return fail(new Error('setup_child_unavailable'));
    input.child.send!(message, error => error ? fail(new Error('setup_child_unavailable')) : done());
  }));
}

type IpcProcess = Pick<NodeJS.Process, 'connected' | 'channel' | 'on' | 'removeListener'>;
const receivers = new WeakSet<object>();
export async function receiveCodexSetupChildStart(input: {process: IpcProcess; signal: AbortSignal; waitMs?: number}) {
  const waitMs = input.waitMs ?? 5000;
  if (!input.process.connected || !input.process.channel || receivers.has(input.process) || input.signal.aborted
    || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 5000) throw new Error('setup_child_unavailable');
  receivers.add(input.process);
  return new Promise<Readonly<CodexSetupChildMessage>>((done, fail) => {
    const cleanup = () => {clearTimeout(timer); input.process.removeListener('message', message);
      input.process.removeListener('disconnect', refused); input.signal.removeEventListener('abort', refused);};
    const refused = () => {cleanup(); fail(new Error('setup_child_unavailable'));};
    const message = (value: unknown) => {
      try {const result = parse(value); if (!input.process.connected || input.signal.aborted) return refused(); cleanup(); done(result);}
      catch {refused();}
    };
    const timer = setTimeout(refused, waitMs);
    input.process.on('message', message); input.process.on('disconnect', refused);
    input.signal.addEventListener('abort', refused, {once: true});
    if (!input.process.connected || input.signal.aborted) refused();
  });
}

export interface CodexSetupChildScope {
  readonly request: Readonly<LocalCodexSetupSessionRequest>;
  step<T>(operation: () => Promise<T>): Promise<T>;
}
/** A one-time child startup continuation, not authority for future work turns. */
export async function runCodexSetupChildStartup<T>(input: {
  vault: Pick<LocalVault, 'readCodexSetupSession' | 'readCodexSetupOperation'>;
  message: CodexSetupChildMessage; name: string; workspaceId: string; signal: AbortSignal;
  authorize(request: Readonly<LocalCodexSetupSessionRequest>): Promise<boolean>;
}, operation: (scope: CodexSetupChildScope) => Promise<T>): Promise<T> {
  const message = parse(input.message), initial = input.vault.readCodexSetupSession(message.operationId, message.intentDigest);
  if (!initial || initial.state !== 'accepted' || initial.result) throw new Error('setup_child_unavailable');
  const request = parseLocalCodexSetupSessionRequest(initial.request);
  if (request.name !== input.name || request.workspaceId !== input.workspaceId) throw new Error('setup_child_unavailable');
  let active = true;
  const check = () => {
    if (!active || input.signal.aborted || Date.now() < Date.parse(request.issuedAt)
      || Date.now() >= Date.parse(request.expiresAt)) throw new Error('setup_child_unavailable');
    const row = input.vault.readCodexSetupSession(message.operationId, message.intentDigest);
    const original = input.vault.readCodexSetupOperation(message.operationId, message.intentDigest);
    if (!row || row.state !== 'accepted' || row.result || canonicalize(row.request) !== canonicalize(request)
      || original?.state !== 'running') throw new Error('setup_child_unavailable');
  };
  const current = async () => {
    check();
    if (!await input.authorize(request)) throw new Error('setup_child_unavailable');
    check();
    if (!active || input.signal.aborted || Date.now() >= Date.parse(request.expiresAt)) throw new Error('setup_child_unavailable');
  };
  const scope: CodexSetupChildScope = Object.freeze({request, async step<T>(effect: () => Promise<T>) {
    await current();
    // No yield between the final lifetime check and the protected effect.
    if (!active || input.signal.aborted) throw new Error('setup_child_unavailable');
    const result = await effect(); await current(); return result;
  }});
  try {await current(); const result = await operation(scope); await current(); return result;}
  finally {active = false;}
}
