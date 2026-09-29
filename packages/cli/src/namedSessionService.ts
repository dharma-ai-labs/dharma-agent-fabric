import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { LocalProviderSessionIdentity, LocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { validateContract, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import { openCodexInboxSession } from './codexInboxSession.js';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { assertCodexWorkPrompt, codexWorkCaptureSchemaId } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { NamedSessionEvidenceReceipt } from './namedSessionEvidence.js';

export interface NamedSessionRegistration {
  schema: 'dharma.named-session/v1';
  name: string;
  bindingId: string;
  identity: LocalProviderSessionIdentity;
  maximumCostCents: number;
  maximumTurnCostCents: number;
  enabled: boolean;
}

function validateRegistration(value: unknown, name: string): asserts value is NamedSessionRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('named_session_registration_invalid');
  const record = value as Record<string, unknown>;
  const keys = ['schema', 'name', 'bindingId', 'identity', 'maximumCostCents', 'maximumTurnCostCents', 'enabled'];
  const ids = ['repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId', 'deviceId'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const identity = record.identity as Record<string, unknown> | undefined;
  if (Object.keys(record).some(key => !keys.includes(key)) || record.schema !== 'dharma.named-session/v1'
    || record.name !== name || typeof record.enabled !== 'boolean'
    || !Number.isSafeInteger(record.maximumCostCents) || Number(record.maximumCostCents) < 1 || Number(record.maximumCostCents) > 10000
    || !Number.isSafeInteger(record.maximumTurnCostCents) || Number(record.maximumTurnCostCents) < 1
    || Number(record.maximumTurnCostCents) > Number(record.maximumCostCents)
    || typeof record.bindingId !== 'string' || !uuid.test(record.bindingId)
    || !identity || typeof identity !== 'object' || Array.isArray(identity)
    || Object.keys(identity).some(key => ![...ids, 'organizationId', 'provider'].includes(key))
    || identity.provider !== 'codex' || typeof identity.organizationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(identity.organizationId)
    || ids.some(key => typeof identity[key] !== 'string' || !uuid.test(identity[key] as string))) {
    throw new Error('named_session_registration_invalid');
  }
}

export function namedSessionPaths(home: string, name: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error('named_session_name_invalid');
  const root = resolve(home, 'sessions', name);
  const socket = resolve(root, 'owner.sock');
  if (Buffer.byteLength(socket) > 103) throw new Error('named_session_socket_path_too_long');
  return { root, socket, registration: resolve(root, 'registration.json'),
    health: resolve(root, 'health.json'), budget: resolve(root, 'budget.sqlite') };
}

export async function readNamedSession(home: string, name: string): Promise<NamedSessionRegistration | null> {
  const path = namedSessionPaths(home, name).registration;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('named_session_registration_invalid');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    validateRegistration(value, name);
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function saveNamedSession(home: string, value: NamedSessionRegistration) {
  validateRegistration(value, value.name);
  const paths = namedSessionPaths(home, value.name);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.registration}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, paths.registration);
}

export async function namedSessionRequest(home: string, name: string, request: Record<string, unknown>) {
  const paths = namedSessionPaths(home, name);
  const serialized = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(serialized) > 20000) throw new Error('named_session_request_too_large');
  return new Promise<Record<string, unknown>>((resolveReply, reject) => {
    const socket = createConnection(paths.socket);
    let bytes = Buffer.alloc(0), complete = false;
    socket.setTimeout(request.action === 'work' ? 310_000 : 30_000);
    const fail = () => { if (!complete) { complete = true; reject(new Error('named_session_unavailable')); } socket.destroy(); };
    socket.on('connect', () => socket.write(serialized));
    socket.on('error', fail); socket.on('timeout', fail);
    socket.on('close', () => { if (!complete) fail(); });
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 50000) { fail(); return; }
      const end = bytes.indexOf(10); if (end < 0) return;
      try {
        const value = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
        complete = true; socket.end();
        if (value.ok !== true) reject(new Error(String(value.code || 'named_session_failed')));
        else resolveReply(value);
      } catch { fail(); }
    });
  });
}

export async function runNamedSessionService(input: {
  home: string; registration: NamedSessionRegistration; vault: LocalVault;
  openTransport: Parameters<typeof openCodexInboxSession>[0]['openTransport'];
  channelTransport: Parameters<typeof openCodexInboxSession>[0]['channelTransport'];
  verifier: SessionQuestionVerifier;
  authorizeContent: Parameters<typeof openCodexInboxSession>[0]['authorizeContent'];
  localWriteRoots: string[];
  authorizeLocalWork(): Promise<boolean>;
  queueEvidence?(capture: CodexLocalWorkCapture): Promise<NamedSessionEvidenceReceipt>;
  withActivationBoundary<T>(operation: () => Promise<T>): Promise<T>;
  signal: AbortSignal;
}) {
  if (process.platform !== 'linux') throw new Error('codex_session_sandbox_unqualified');
  const { NamedSessionBudget } = await import('./namedSessionBudget.js');
  const registration = input.registration, paths = namedSessionPaths(input.home, registration.name);
  if (!registration.enabled) throw new Error('named_session_disabled');
  const binding = input.vault.getProviderSessionBinding(registration.bindingId, registration.identity);
  if (!binding) throw new Error('named_session_binding_unavailable');
  const budget = new NamedSessionBudget(paths.budget, createHash('sha256').update(JSON.stringify(registration.identity)).digest('hex'),
    registration.maximumCostCents);
  budget.recoverInterruptedWork();
  let owner: Awaited<ReturnType<typeof openCodexInboxSession>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  const connections = new Set<Socket>();
  const responses = new Set<Promise<void>>();
  let closing = false, pending = 0, serial = Promise.resolve();
  let lastObservation: unknown = { state: 'starting' };
  const status = () => ({ ok: true, schema: 'dharma.named-session-status/v1', name: registration.name,
    bindingId: binding.bindingId, sessionId: binding.sessionId, ...registration.identity,
    state: closing ? 'stopping' : pending ? 'executing' : 'running', budget: budget.status(),
    queued: pending, lastObservation, lastWork: budget.lastWork() });
  let healthWrites = Promise.resolve();
  const health = () => {
    const snapshot = JSON.stringify({ ...status(), pid: process.pid, observedAt: new Date().toISOString() });
    const write = healthWrites.then(async () => {
      const temporary = `${paths.health}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
      await rename(temporary, paths.health);
    });
    healthWrites = write.catch(() => {});
    return write;
  };
  function enqueue<T>(operation: () => Promise<T>) {
    if (closing || pending >= 8) return Promise.reject(new Error('named_session_busy'));
    pending++;
    const result = serial.then(async () => {
      try {
        if (closing) throw new Error('named_session_stopped');
        return await operation();
      } finally {
        pending--;
        await health();
      }
    });
    serial = result.then(() => undefined, () => undefined);
    return result;
  }
  try {
    owner = await openCodexInboxSession({ ...input, ...registration,
      authorizeLocalTools: input.authorizeLocalWork,
      budget: { reserve: async (id, cents) => cents <= registration.maximumTurnCostCents && budget.reserve(id, cents) } });
    // The vault lease proves the previous provider owner is gone before stale socket removal.
    const old = await lstat(paths.socket).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (old) { if (!old.isSocket()) throw new Error('named_session_socket_conflict'); await unlink(paths.socket); }
    server = createServer(socket => {
      connections.add(socket); socket.once('close', () => connections.delete(socket));
      let bytes = Buffer.alloc(0), handled = false;
      const respond = (value: unknown) => new Promise<void>(resolveReply => {
        if (socket.destroyed) { resolveReply(); return; }
        const done = () => { socket.off('close', done); resolveReply(); };
        socket.once('close', done);
        try {
          socket.setTimeout(30_000, () => socket.destroy());
          socket.end(`${JSON.stringify(value)}\n`);
        }
        catch { socket.destroy(); done(); }
      });
      socket.setTimeout(310_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        if (handled) return;
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 20000) { handled = true; socket.destroy(); return; }
        const end = bytes.indexOf(10); if (end < 0) return;
        handled = true;
        const response = (async () => {
          const request = JSON.parse(bytes.subarray(0, end).toString('utf8')) as Record<string, unknown>;
          if (request.action === 'status') return status();
          if (request.action === 'stop') { closing = true; return { ok: true, state: 'stop_requested' }; }
          return enqueue(async () => {
            if (request.action === 'work') {
              if (typeof request.prompt !== 'string' || typeof request.workId !== 'string') throw new Error('named_session_work_invalid');
              assertCodexWorkPrompt(request.prompt);
              if (!await input.authorizeLocalWork()) throw new Error('named_session_workspace_write_not_authorized');
              const intent = await input.vault.putBlob(Buffer.from(JSON.stringify({ workId: request.workId,
                prompt: request.prompt, bindingId: binding.bindingId })), 'named-session-work-intent');
              budget.beginWork(request.workId, intent);
              let nativeEvidence: Record<string, unknown> | null = null;
              try {
                const result = await input.withActivationBoundary(() => owner!.runWork({ workId: request.workId as string,
                  prompt: request.prompt as string, maximumProviderCostCents: registration.maximumTurnCostCents,
                  onTurnEvidence: async capture => {
                    const valid = await validateContract(join(import.meta.dirname, 'schemas'),
                      codexWorkCaptureSchemaId(capture), capture);
                    if (!valid.ok) throw new Error('codex_session_evidence_invalid');
                    const contentHash = await input.vault.putBlob(Buffer.from(JSON.stringify(capture)), 'raw-provider-turn');
                    nativeEvidence = { schema: capture.schema, captureId: capture.captureId, contentHash,
                      ...(capture.schema === 'dharma.codex-local-work-capture/v2' ? { requestHash: capture.requestHash } : {}),
                      coverage: capture.coverage, limitations: capture.limitations, providerTurnState: capture.providerTurnState,
                      acceptedLearningObservation: false };
                    if (input.queueEvidence) {
                      let synchronization: NamedSessionEvidenceReceipt;
                      try {
                        synchronization = await input.queueEvidence(capture);
                        const checked = await validateContract(join(import.meta.dirname, 'schemas'),
                          'https://schemas.dharma-ai.io/named-session-evidence/v1', synchronization);
                        if (!checked.ok || synchronization.captureHash !== contentHash || synchronization.captureId !== capture.captureId
                          || synchronization.organizationId !== capture.organizationId || synchronization.deviceId !== capture.deviceId
                          || synchronization.workspaceId !== capture.workspaceId || synchronization.bindingId !== capture.bindingId
                          || synchronization.workId !== capture.workId) throw new Error('named_session_evidence_receipt_invalid');
                      } catch {
                        // Evidence failure cannot rewrite the actual coding result or authorize another provider turn.
                        synchronization = { schema: 'dharma.named-session-evidence/v1', organizationId: capture.organizationId,
                          deviceId: capture.deviceId, workspaceId: capture.workspaceId, bindingId: capture.bindingId,
                          workId: capture.workId, captureId: capture.captureId, captureHash: contentHash, createdAt: capture.closedAt,
                          state: 'blocked', trajectoryId: null, capsuleHash: null, code: 'evidence_queue_failed',
                          acceptedLearningObservation: false };
                      }
                      nativeEvidence.synchronization = synchronization;
                    }
                  } }));
                const receipt = { ...result, intentHash: intent, nativeEvidence };
                const blob = await input.vault.putBlob(Buffer.from(JSON.stringify(receipt)), 'named-session-work');
                budget.finishWork(request.workId, 'completed', blob);
                await health(); return { ok: true, ...receipt, completionHash: blob };
              } catch (error) {
                const blob = await input.vault.putBlob(Buffer.from(JSON.stringify({ workId: request.workId, intentHash: intent,
                  code: error instanceof Error ? error.message : 'named_session_work_failed', nativeEvidence })), 'named-session-work-failure');
                budget.finishWork(request.workId, 'failed', blob);
                if (!await owner!.assertActive()) closing = true;
                await health(); throw error;
              }
            }
            if (request.action === 'ask') return { ok: true, ...await owner!.ask({
              targetBindingId: String(request.targetBindingId || ''), taskId: String(request.taskId || ''),
              category: String(request.category || ''), question: String(request.question || ''),
              maximumProviderCostCents: registration.maximumTurnCostCents }) };
            if (request.action === 'read') return { ok: true, ...await owner!.read(String(request.questionId || ''),
              String(request.taskId || ''), String(request.targetBindingId || '')) };
            throw new Error('named_session_action_invalid');
          });
        })().then(result => respond(result), error => respond({ ok: false,
          code: error instanceof Error ? error.message : 'named_session_failed' }))
          .catch(() => { socket.destroy(); });
        responses.add(response);
        void response.then(() => responses.delete(response));
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once('error', reject); server!.listen(paths.socket, resolveListen);
    });
    await chmod(paths.socket, 0o600); await health();
    while (!closing && !input.signal.aborted) {
      let result: Awaited<ReturnType<NonNullable<typeof owner>['runNext']>>;
      try { result = await enqueue(() => input.withActivationBoundary(() => owner!.runNext())); }
      catch (error) { if (closing || input.signal.aborted) break; throw error; }
      lastObservation = result; await health();
      if (result.state === 'reply_pending') throw new Error('named_session_reply_pending');
      await new Promise<void>(resolveWait => {
        const done = () => { clearTimeout(timer); input.signal.removeEventListener('abort', done); resolveWait(); };
        const timer = setTimeout(done, 1000); input.signal.addEventListener('abort', done, { once: true });
        if (input.signal.aborted) done();
      });
    }
    return { ok: true, state: 'stopped' };
  } finally {
    closing = true;
    // Interrupt an in-flight turn and preserve its reservation; do not replay it on restart.
    try { if (owner) await owner.close(); }
    finally {
      try {
        const serverClosed = server?.listening
          ? new Promise<void>(resolveClose => server!.close(() => resolveClose())) : null;
        await serial;
        // An accepted work failure must reach its caller before shutdown tears down the socket.
        await Promise.allSettled([...responses]);
        if (server) {
          for (const connection of connections) connection.destroy();
          if (serverClosed) await serverClosed;
          await unlink(paths.socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        await health();
      } finally { budget.close(); }
    }
  }
}
