import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  validateProviderSessionRegistrationV2Contract,
  type ProviderSessionRegistrationV2,
} from '@dharma-ai-labs/agent-fabric-contracts';
import {
  readSessionAttachment,
  recordClaudeSessionStart,
  sessionNamesCommand,
  type SessionMessageTransport,
  type SessionMessagingHost,
} from './sessionNames.js';

const ORG = 'org-hq';
const DEVICE = randomUUID();
const MEMBER = randomUUID();
const THREAD = randomUUID();

type Call = { method: 'GET' | 'POST'; route: string; body?: unknown };

function flags(entries: Array<[string, string | boolean]>) { return new Map(entries); }

function receiptFor(request: ProviderSessionRegistrationV2, overrides: Record<string, unknown> = {}) {
  return { schema: 'dharma.provider-session-registration-receipt/v2', organizationId: request.organizationId,
    bindingId: request.bindingId, name: request.name, provider: request.provider, delivery: request.delivery,
    mode: 'cooperative', membershipId: MEMBER, deviceId: request.deviceId, state: 'active',
    revision: request.expectedRevision + 1, replay: false, updatedAt: '2026-11-10T10:00:00.000Z', ...overrides };
}

async function fixture(options: {
  post?: (route: string, body: unknown, calls: Call[]) => Promise<Record<string, unknown>>;
  get?: (route: string, calls: Call[]) => Promise<Record<string, unknown>>;
  env?: Record<string, string | undefined>;
  cwd?: string;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dharma-session-names-'));
  const calls: Call[] = [];
  let deviceReads = 0;
  const transport: SessionMessageTransport = {
    async signedPost(route, body) {
      calls.push({ method: 'POST', route, body: JSON.parse(JSON.stringify(body)) });
      if (options.post) return options.post(route, body, calls);
      return receiptFor(body as ProviderSessionRegistrationV2);
    },
    async signedGet(route) {
      calls.push({ method: 'GET', route });
      if (options.get) return options.get(route, calls);
      return { sessions: [] };
    },
  };
  const { privateKey } = generateKeyPairSync('ed25519');
  const host: SessionMessagingHost = {
    home, cwd: options.cwd ?? join(home, 'work'), env: options.env ?? {},
    now: () => new Date('2026-11-10T10:05:00.000Z'),
    device: async () => { deviceReads += 1; return { organizationId: ORG, deviceId: DEVICE, privateKey }; },
    transport: async () => transport,
  };
  return { home, host, calls, deviceReads: () => deviceReads, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('codex attach sends a valid registration v2 request with no thread id and keeps the thread id local', async () => {
  const f = await fixture();
  try {
    const result = await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef'], ['yes', true]]), f.host);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.route, '/agent-fabric/session-names/attach');
    const request = f.calls[0]!.body as ProviderSessionRegistrationV2;
    assert.deepEqual(validateProviderSessionRegistrationV2Contract(request), { ok: true });
    assert.equal(request.action, 'attach');
    assert.equal(request.provider, 'codex');
    assert.equal(request.delivery, 'codex_queue');
    assert.equal(request.mode, 'cooperative');
    assert.equal(request.organizationId, ORG);
    assert.equal(request.deviceId, DEVICE);
    assert.equal(request.expectedRevision, 0);
    assert.ok(!JSON.stringify(f.calls).includes(THREAD), 'the thread id never leaves the device');
    assert.equal(result.ok, true);
    assert.equal(result.name, 'ef');
    assert.equal(result.state, 'active');
    assert.equal(result.delivery, 'codex_queue');
    assert.equal(result.mode, 'cooperative');
    assert.match(String(result.consent), /Any active member of org-hq can message this session/);
    assert.ok(!JSON.stringify(result).includes(THREAD));
    const local = await readSessionAttachment(f.home, 'ef');
    assert.equal(local?.threadId, THREAD);
    assert.equal(local?.membershipId, MEMBER);
    assert.equal(local?.bindingId, request.bindingId);
    assert.equal(local?.revision, 1);
    assert.equal(local?.pending, false);
  } finally { await f.cleanup(); }
});

test('claude attach --current uses the SessionStart record named by the hook environment', async () => {
  const sessionId = randomUUID();
  const other = randomUUID();
  const f = await fixture({ env: { DHARMA_CLAUDE_SESSION_ID: sessionId } });
  try {
    await recordClaudeSessionStart(f.home, { sessionId, cwd: f.host.cwd, at: '2026-11-10T09:00:00.000Z' });
    await recordClaudeSessionStart(f.home, { sessionId: other, cwd: f.host.cwd, at: '2026-11-10T09:30:00.000Z' });
    const result = await sessionNamesCommand('attach', flags([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), f.host);
    const request = f.calls[0]!.body as ProviderSessionRegistrationV2;
    assert.equal(request.provider, 'claude');
    assert.equal(request.delivery, 'claude_hook');
    assert.ok(!JSON.stringify(f.calls).includes(sessionId), 'the Claude session id never leaves the device');
    assert.equal(result.delivery, 'claude_hook');
    const local = await readSessionAttachment(f.home, 'ops-claude');
    assert.equal(local?.claudeSessionId, sessionId);
    assert.equal(local?.cwd, f.host.cwd);
  } finally { await f.cleanup(); }
});

test('claude --current without the hook environment needs exactly one SessionStart record for this directory', async () => {
  const f = await fixture();
  try {
    await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), f.host), /claude_current_session_unavailable/);
    const only = randomUUID();
    await recordClaudeSessionStart(f.home, { sessionId: only, cwd: f.host.cwd, at: '2026-11-10T09:00:00.000Z' });
    await recordClaudeSessionStart(f.home, { sessionId: randomUUID(), cwd: join(f.home, 'elsewhere'), at: '2026-11-10T09:00:00.000Z' });
    await sessionNamesCommand('attach', flags([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), f.host);
    assert.equal((await readSessionAttachment(f.home, 'ops-claude'))?.claudeSessionId, only);
    await recordClaudeSessionStart(f.home, { sessionId: randomUUID(), cwd: f.host.cwd, at: '2026-11-10T09:10:00.000Z' });
    await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'claude'], ['current', true],
      ['name', 'second'], ['yes', true]]), f.host), /claude_current_session_ambiguous/);
  } finally { await f.cleanup(); }
  const g = await fixture({ env: { DHARMA_CLAUDE_SESSION_ID: randomUUID() } });
  try {
    await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), g.host), /claude_current_session_unavailable/);
  } finally { await g.cleanup(); }
});

test('attach needs --yes; --dry-run returns the plan; neither reads the device or calls the platform', async () => {
  const f = await fixture();
  try {
    await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef']]), f.host), /session_attach_consent_required/);
    const plan = await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef'], ['dry-run', true]]), f.host);
    assert.equal(plan.stage, 'plan');
    assert.equal(plan.effects, false);
    assert.equal(plan.delivery, 'codex_queue');
    assert.equal(f.calls.length, 0);
    assert.equal(f.deviceReads(), 0);
    assert.equal(await readSessionAttachment(f.home, 'ef'), null);
  } finally { await f.cleanup(); }
});

test('attach refuses malformed options before any device or network access', async () => {
  const f = await fixture();
  try {
    for (const entries of [
      [['provider', 'codex'], ['current', true], ['name', 'ef'], ['yes', true]],
      [['provider', 'claude'], ['thread', THREAD], ['name', 'ef'], ['yes', true]],
      [['provider', 'codex'], ['thread', 'not-a-thread'], ['name', 'ef'], ['yes', true]],
      [['provider', 'codex'], ['thread', THREAD], ['name', 'EF'], ['yes', true]],
      [['provider', 'codex'], ['thread', THREAD], ['name', 'ef'], ['yes', 'please']],
      [['provider', 'grok'], ['thread', THREAD], ['name', 'ef'], ['yes', true]],
      [['provider', 'codex'], ['thread', THREAD], ['name', 'ef'], ['yes', true], ['workspace-id', 'x']],
    ] as Array<Array<[string, string | boolean]>>) {
      await assert.rejects(sessionNamesCommand('attach', flags(entries), f.host), /session_attach_options_invalid/,
        JSON.stringify(entries));
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.deviceReads(), 0);
  } finally { await f.cleanup(); }
});

test('an uncertain attach is retried once with the identical request; a definitive refusal is not retried', async () => {
  let attempts = 0;
  const f = await fixture({ post: async (_route, body) => {
    attempts += 1;
    if (attempts === 1) throw new Error('fetch failed');
    return receiptFor(body as ProviderSessionRegistrationV2, { replay: true });
  } });
  try {
    const result = await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef'], ['yes', true]]), f.host);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[0]!.body, f.calls[1]!.body);
    assert.equal(result.replay, true);
  } finally { await f.cleanup(); }
  const g = await fixture({ post: async () => {
    throw Object.assign(new Error('session_messaging_forbidden'), { status: 403, definitive: true });
  } });
  try {
    await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef'], ['yes', true]]), g.host), /session_messaging_forbidden/);
    assert.equal(g.calls.length, 1);
    assert.equal((await readSessionAttachment(g.home, 'ef'))?.pending, true);
  } finally { await g.cleanup(); }
});

test('a receipt for another binding, name or state is refused and the attachment stays pending', async () => {
  for (const overrides of [{ bindingId: randomUUID() }, { name: 'other' }, { state: 'detached' },
    { delivery: 'claude_hook', provider: 'claude' }, { deviceId: randomUUID() }, { extra: true }]) {
    const f = await fixture({ post: async (_route, body) => receiptFor(body as ProviderSessionRegistrationV2, overrides) });
    try {
      await assert.rejects(sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
        ['name', 'ef'], ['yes', true]]), f.host), /session_attach_receipt_invalid/, JSON.stringify(overrides));
      assert.equal((await readSessionAttachment(f.home, 'ef'))?.pending, true);
    } finally { await f.cleanup(); }
  }
});

test('re-attaching the same session reuses its binding id and expected revision', async () => {
  const f = await fixture();
  try {
    const attach = () => sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD],
      ['name', 'ef'], ['yes', true]]), f.host);
    await attach();
    await attach();
    const [first, second] = f.calls.map(call => call.body as ProviderSessionRegistrationV2);
    assert.equal(second!.bindingId, first!.bindingId);
    assert.equal(second!.expectedRevision, 1);
    assert.equal((await readSessionAttachment(f.home, 'ef'))?.revision, 2);
    await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', randomUUID()],
      ['name', 'ef'], ['yes', true]]), f.host);
    const third = f.calls[2]!.body as ProviderSessionRegistrationV2;
    assert.notEqual(third.bindingId, first!.bindingId, 'another thread under the same name is a new binding');
    assert.equal(third.expectedRevision, 0);
  } finally { await f.cleanup(); }
});

test('sessions list shows names, owners and "seen N min ago", marks local names and refuses device or session ids', async () => {
  const f = await fixture({ get: async () => ({ sessions: [
    { name: 'ef', provider: 'codex', ownerDisplayName: 'Nick', lastSeenAt: '2026-11-10T10:02:00.000Z', state: 'active' },
    { name: 'ops-claude', provider: 'claude', ownerDisplayName: 'Test member 2', lastSeenAt: null, state: 'active' },
  ] }) });
  try {
    await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD], ['name', 'ef'], ['yes', true]]), f.host);
    const result = await sessionNamesCommand('list', flags([]), f.host);
    assert.equal(f.calls.at(-1)!.method, 'GET');
    assert.equal(f.calls.at(-1)!.route, '/agent-fabric/session-names');
    assert.deepEqual(result.sessions, [
      { name: 'ef', provider: 'codex', owner: 'Nick', seen: 'seen 3 min ago', lastSeenAt: '2026-11-10T10:02:00.000Z',
        state: 'active', attachedHere: true },
      { name: 'ops-claude', provider: 'claude', owner: 'Test member 2', seen: 'not seen yet', lastSeenAt: null,
        state: 'active', attachedHere: false },
    ]);
  } finally { await f.cleanup(); }
  for (const extra of [{ deviceId: DEVICE }, { threadId: THREAD }, { sessionId: 'x' }]) {
    const g = await fixture({ get: async () => ({ sessions: [{ name: 'ef', provider: 'codex', ownerDisplayName: 'Nick',
      lastSeenAt: null, state: 'active', ...extra }] }) });
    try {
      await assert.rejects(sessionNamesCommand('list', flags([]), g.host), /session_directory_response_invalid/);
    } finally { await g.cleanup(); }
  }
});

test('local attachment records are written atomically under the session-messages state directory', async () => {
  const f = await fixture();
  try {
    await sessionNamesCommand('attach', flags([['provider', 'codex'], ['thread', THREAD], ['name', 'ef'], ['yes', true]]), f.host);
    const directory = join(f.home, 'session-messages', 'attachments');
    assert.deepEqual(await readdir(directory), ['ef.json']);
    const stored = JSON.parse(await readFile(join(directory, 'ef.json'), 'utf8'));
    assert.equal(stored.schema, 'dharma.local-session-attachment/v1');
  } finally { await f.cleanup(); }
});
