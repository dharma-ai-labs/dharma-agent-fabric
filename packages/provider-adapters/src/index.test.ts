import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import {
  agyCapability,
  agyAdapter,
  codexAdapter,
  defaultProcessRunner,
  executableVersion,
  executeProviderTask,
  hermesCapability,
  hermesAdapter,
  parseHermesSessionExport,
  providerExecutionRecords,
  providerProcessEnvironment,
} from './index.js';

test('provider discovery finds supported per-user CLI installations outside the parent PATH', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-provider-local-bin-'));
  const localBin = join(home, '.local', 'bin');
  let observedPath = '';
  const version = await executableVersion(
    'agy',
    { HOME: home, PATH: '/usr/bin:/bin' },
    (executable, argv, options) => {
      assert.equal(executable, 'agy');
      assert.deepEqual(argv, ['--version']);
      observedPath = String(options.env.PATH || '');
      return { status: 0, stdout: '1.1.15\n', stderr: '' };
    },
  );
  assert.equal(version, '1.1.15');
  assert.equal(observedPath, ['/usr/bin:/bin', localBin].join(delimiter));
});

test('Agy 1.1.13 capabilities fail closed for signed effects and host lifecycle claims', () => {
  assert.deepEqual(agyCapability('1.1.13'), {
    provider: 'agy',
    version: '1.1.13',
    evidence: 'partial',
    configuredAssets: 'partial',
    taskExecution: 'partial',
    sessionContinuation: 'partial',
    skillInstall: 'partial',
    activation: 'unavailable',
    skillRollback: 'unavailable',
    usageEvidence: 'unavailable',
  });
  assert.deepEqual(agyCapability(null), {
    provider: 'agy',
    version: null,
    evidence: 'unavailable',
    configuredAssets: 'unavailable',
    taskExecution: 'unavailable',
    sessionContinuation: 'unavailable',
    skillInstall: 'unavailable',
    activation: 'unavailable',
    skillRollback: 'unavailable',
    usageEvidence: 'unavailable',
  });
});

test('Agy 1.1.15 advertises content-attested activation and transactional rollback support', () => {
  assert.deepEqual(agyCapability('1.1.15'), {
    provider: 'agy',
    version: '1.1.15',
    evidence: 'partial',
    configuredAssets: 'partial',
    taskExecution: 'partial',
    sessionContinuation: 'partial',
    skillInstall: 'partial',
    activation: 'next_session',
    skillRollback: 'available',
    usageEvidence: 'unavailable',
  });
});

test('Hermes capabilities distinguish an installed host from an unavailable host', () => {
  assert.deepEqual(hermesCapability('0.20.4'), {
    provider: 'hermes', version: '0.20.4', evidence: 'available', configuredAssets: 'partial',
    taskExecution: 'partial', sessionContinuation: 'unavailable', skillInstall: 'available',
    activation: 'next_session', skillRollback: 'available', usageEvidence: 'partial',
  });
  assert.equal(hermesCapability(null).taskExecution, 'unavailable');
  assert.equal(hermesCapability(null).skillInstall, 'unavailable');
});

test('provider subprocess environment excludes cloud and model credentials', () => {
  const env = providerProcessEnvironment({
    PATH: '/usr/bin', HOME: '/home/customer', CODEX_HOME: '/home/customer/.codex',
    OPENAI_API_KEY: 'openai-secret', ANTHROPIC_API_KEY: 'anthropic-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gcp-key.json', AWS_SECRET_ACCESS_KEY: 'aws-secret',
  });
  assert.equal(env.PATH, ['/usr/bin', resolve('/home/customer', '.local', 'bin')].join(delimiter));
  assert.equal(env.HOME, '/home/customer');
  assert.equal(env.CODEX_HOME, '/home/customer/.codex');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DHARMA_AGENT_FABRIC_TASK, '1');
});

test('provider subprocess environment adds the supported per-user CLI install directory once', () => {
  const localBin = resolve('/home/customer', '.local', 'bin');
  const env = providerProcessEnvironment({
    HOME: '/home/customer',
    PATH: ['/usr/bin', localBin].join(delimiter),
  });
  assert.deepEqual(env.PATH?.split(delimiter), ['/usr/bin', localBin]);
});

test('Claude signed-task output preserves ordered tool evidence without reasoning content', () => {
  const records = providerExecutionRecords({
    provider: 'claude',
    workspace: '/workspace',
    startedAt: '2026-08-18T18:00:00.000Z',
    endedAt: '2026-08-18T18:00:01.000Z',
    stdout: [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private chain' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'package evidence' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The package is Agent Fabric.' }] } },
      { type: 'result', subtype: 'success', result: 'The package is Agent Fabric.' },
    ].map((value) => JSON.stringify(value)).join('\n'),
  });

  assert.deepEqual(records.map((record) => record.kind), ['tool_call', 'tool_result', 'agent_message']);
  assert.equal(records[0]?.native.toolName, 'Read');
  assert.equal(records[1]?.native.toolUseId, 'tool-1');
  assert.equal(records[2]?.native.content, 'The package is Agent Fabric.');
  assert.equal(JSON.stringify(records).includes('private chain'), false);
});

test('provider execution output retains the bounded message fallback for plain output', () => {
  const records = providerExecutionRecords({
    provider: 'agy',
    workspace: '/workspace',
    startedAt: '2026-08-18T18:00:00.000Z',
    endedAt: '2026-08-18T18:00:01.000Z',
    stdout: 'plain provider response',
  });
  assert.deepEqual(records.map((record) => record.kind), ['agent_message']);
  assert.equal(records[0]?.native.content, 'plain provider response');
});

test('Codex discovery admits only sessions bound to the requested workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'good.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' }),
    JSON.stringify({ type: 'user_message', payload: { cwd: workspace, text: 'fix the test' }, timestamp: '2026-08-03T01:00:01Z' }),
  ].join('\n'));
  await writeFile(join(sessions, 'foreign.jsonl'), JSON.stringify({ type: 'user_message', cwd: join(root, 'other') }));

  const result = await codexAdapter.discover({ workspace, roots: [sessions] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.records.length, 2);
});

test('Agy discovery uses supported workspace history and reports partial evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-agy-history-'));
  const workspace = join(root, 'repo');
  const history = join(root, 'history.jsonl');
  await mkdir(workspace);
  await writeFile(history, [
    JSON.stringify({ display: 'Inspect checkout', timestamp: 1_786_000_000_000, workspace, conversationId: 'conversation-one' }),
    JSON.stringify({ display: 'Foreign checkout', timestamp: 1_786_000_001_000, workspace: join(root, 'foreign'), conversationId: 'conversation-two' }),
  ].join('\n'));
  const result = await agyAdapter.discover({ workspace, roots: [history] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.provider, 'agy');
  assert.equal(result[0]?.coverage, 'partial');
  assert.equal(result[0]?.records[0]?.native.display, 'Inspect checkout');
});

test('Agy discovery reads the current native transcript bound by its workspace cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-agy-native-'));
  const workspace = join(root, 'repo');
  const config = join(root, 'agy');
  const conversationId = '632da697-07a4-4dfe-9139-78729df9bac4';
  const logs = join(config, 'brain', conversationId, '.system_generated', 'logs');
  await mkdir(workspace);
  await mkdir(join(config, 'cache'), { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeFile(join(config, 'cache', 'last_conversations.json'), JSON.stringify({
    [workspace]: conversationId,
    [join(root, 'foreign')]: '176b23b1-bbef-46be-a993-92c4febc2440',
  }));
  await writeFile(join(logs, 'transcript_full.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', content: 'Inspect authority.', created_at: '2026-08-14T22:52:34Z' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Approval is missing.', created_at: '2026-08-14T22:52:35Z' }),
  ].join('\n'));
  const previous = process.env.AGY_CONFIG_DIR;
  process.env.AGY_CONFIG_DIR = config;
  try {
    const result = await agyAdapter.discover({ workspace });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.provider, 'agy');
    assert.equal(result[0]?.coverage, 'observed');
    assert.equal(result[0]?.records.length, 2);
    assert.equal(result[0]?.records[0]?.workspace, workspace);
    assert.equal(result[0]?.records[1]?.native.content, 'Approval is missing.');
  } finally {
    if (previous === undefined) delete process.env.AGY_CONFIG_DIR;
    else process.env.AGY_CONFIG_DIR = previous;
  }
});

test('Hermes discovery parses only redacted official exports bound to the requested workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-hermes-export-'));
  const workspace = join(root, 'repo');
  const foreign = join(root, 'foreign');
  const exports = join(root, 'exports');
  await mkdir(workspace);
  await mkdir(foreign);
  await mkdir(exports);
  const rows = [
    {
      id: 'session-local', cwd: workspace,
      started_at: '2026-08-19T10:00:00Z', updated_at: '2026-08-19T10:00:02Z',
      messages: [
        { role: 'user', content: 'Inspect the repository.', timestamp: '2026-08-19T10:00:01Z' },
        { role: 'assistant', content: 'The repository is bounded.', timestamp: '2026-08-19T10:00:02Z' },
      ],
    },
    {
      id: 'session-foreign', cwd: foreign,
      messages: [{ role: 'user', content: 'Do not admit.', timestamp: '2026-08-19T10:00:03Z' }],
    },
  ].map((row) => JSON.stringify(row)).join('\n');
  const parsed = parseHermesSessionExport(rows, workspace);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.provider, 'hermes');
  assert.equal(parsed[0]?.coverage, 'observed');
  assert.deepEqual(parsed[0]?.records.map((record) => record.kind), ['user_message', 'agent_message']);
  await writeFile(join(exports, 'sessions.jsonl'), rows);
  const discovered = await hermesAdapter.discover({ workspace, roots: [exports] });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.sessionId, parsed[0]?.sessionId);
});

test('Codex discovery supports no-copy JSONL source selectors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-adapter-symlink-'));
  const workspace = join(root, 'repo');
  const source = join(root, 'source');
  const selector = join(root, 'selector');
  await mkdir(workspace);
  await mkdir(source);
  await mkdir(selector);
  const session = join(source, 'session.jsonl');
  await writeFile(session, JSON.stringify({ cwd: workspace, timestamp: '2026-08-04T00:00:00Z', type: 'event_msg' }));
  await symlink(session, join(selector, 'selected.jsonl'));

  const result = await codexAdapter.discover({ workspace, roots: [selector] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.records.length, 1);
  assert.equal(result[0]?.sourcePath, await realpath(session));
});

test('cwd-less sessions are not inferred into a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'unknown.jsonl'), JSON.stringify({ type: 'user_message', text: 'unbound' }));
  assert.deepEqual(await codexAdapter.discover({ workspace, roots: [sessions] }), []);
});

test('discovery bounds oversized sessions and marks sampled evidence partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'large.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' }),
    JSON.stringify({ type: 'tool_result', payload: { cwd: workspace, output: 'x'.repeat(300_000) } }),
    JSON.stringify({ type: 'assistant_message', payload: { cwd: workspace, text: 'bounded result' }, timestamp: '2026-08-03T01:00:02Z' }),
  ].join('\n'));
  const result = await codexAdapter.discover({
    workspace,
    roots: [sessions],
    maximumSessions: 1,
    maximumBytesPerSession: 131_072,
    maximumRecordBytes: 65_536,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.coverage, 'partial');
  assert.ok((result[0]?.records.length ?? 0) <= 2);
});

test('oversized discovery admits only complete explicit turns from the bounded tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  const firstTurn = '019fcaab-6c8e-7432-bfb7-fc63efa3d728';
  const secondTurn = '019fcaac-6c8e-7432-bfb7-fc63efa3d729';
  await writeFile(join(sessions, 'large-turns.jsonl'), [
    { type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' },
    { type: 'turn_context', payload: { turn_id: firstTurn, cwd: workspace }, timestamp: '2026-08-03T01:00:01Z' },
    { type: 'tool_result', payload: { cwd: workspace, output: 'x'.repeat(150_000) } },
    { type: 'turn_context', payload: { turn_id: secondTurn, cwd: workspace }, timestamp: '2026-08-03T02:00:00Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'complete tail task' }, timestamp: '2026-08-03T02:00:01Z' },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'complete tail result' }, timestamp: '2026-08-03T02:00:02Z' },
  ].map((value) => JSON.stringify(value)).join('\n'));

  const result = await codexAdapter.discover({
    workspace,
    roots: [sessions],
    maximumBytesPerSession: 131_072,
    maximumRecordBytes: 65_536,
  });

  const second = result.find((session) => session.sessionId.endsWith(secondTurn));
  assert.equal(second?.coverage, 'observed');
  assert.deepEqual(second?.records.map((record) => record.kind), ['metadata', 'user_message', 'agent_message']);
  assert.ok(result.every((session) => session.sessionId.endsWith(secondTurn) || session.coverage === 'partial'));
});

test('Codex Desktop nested payloads retain semantic event kinds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'desktop.jsonl'), [
    { type: 'session_meta', payload: { cwd: workspace } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell_command' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } },
    { type: 'event_msg', payload: { type: 'error', message: 'failed' } },
  ].map((value) => JSON.stringify(value)).join('\n'));
  const result = await codexAdapter.discover({ workspace, roots: [sessions] });
  assert.deepEqual(result[0]?.records.map((record) => record.kind), [
    'metadata', 'user_message', 'agent_message', 'tool_call', 'tool_result', 'error',
  ]);
});

test('Codex discovery strips encrypted reasoning while retaining visible provider evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'protected.jsonl'), [
    { type: 'session_meta', payload: { cwd: workspace } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible evidence.' }],
        encrypted_content: 'opaque-protected-reasoning',
        encryptedReasoning: 'opaque-protected-reasoning-v2',
      },
    },
  ].map((value) => JSON.stringify(value)).join('\n'));

  const result = await codexAdapter.discover({ workspace, roots: [sessions] });
  const message = result[0]?.records[1]?.native as Record<string, unknown>;
  const payload = message.payload as Record<string, unknown>;
  assert.deepEqual(payload.content, [{ type: 'output_text', text: 'Visible evidence.' }]);
  assert.equal('encrypted_content' in payload, false);
  assert.equal('encryptedReasoning' in payload, false);
});

test('Codex Desktop discovery emits one session per real turn context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  const firstTurn = '019fcaab-6c8e-7432-bfb7-fc63efa3d728';
  const secondTurn = '019fcaac-6c8e-7432-bfb7-fc63efa3d729';
  await writeFile(join(sessions, 'desktop-turns.jsonl'), [
    { type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' },
    { type: 'turn_context', payload: { turn_id: firstTurn, cwd: workspace }, timestamp: '2026-08-03T01:00:01Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first task' }, timestamp: '2026-08-03T01:00:02Z' },
    { type: 'turn_context', payload: { turn_id: firstTurn, cwd: workspace }, timestamp: '2026-08-03T01:00:03Z' },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'first result' }, timestamp: '2026-08-03T01:00:04Z' },
    { type: 'turn_context', payload: { turn_id: secondTurn, cwd: workspace }, timestamp: '2026-08-03T02:00:00Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second task' }, timestamp: '2026-08-03T02:00:01Z' },
  ].map((value) => JSON.stringify(value)).join('\n'));

  const result = await codexAdapter.discover({ workspace, roots: [sessions] });
  assert.equal(result.length, 2);
  assert.match(result[0]?.sessionId || '', new RegExp(`${firstTurn}$`));
  assert.match(result[1]?.sessionId || '', new RegExp(`${secondTurn}$`));
  assert.deepEqual(result.map((session) => session.records.filter((record) => record.kind === 'user_message').length), [1, 1]);
  assert.equal(result[0]?.records[0]?.native.type, 'session_meta');
  assert.equal(result[1]?.records[0]?.native.type, 'turn_context');

  const latest = await codexAdapter.discover({ workspace, roots: [sessions], maximumSessions: 1 });
  assert.equal(latest.length, 1);
  assert.match(latest[0]?.sessionId || '', new RegExp(`${secondTurn}$`));

  const exactOlder = await codexAdapter.discover({
    workspace, roots: [sessions], maximumSessions: 1, sessionIds: [result[0]!.sessionId],
  });
  assert.deepEqual(exactOlder.map((session) => session.sessionId), [result[0]!.sessionId]);
});

test('Codex task execution uses stdin, workspace sandboxing, and disabled network without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  let observed: Record<string, unknown> = {};
  const result = await executeProviderTask({
    provider: 'codex', workspace: root, instructions: 'Fix the parser test.', timeoutSeconds: 30, allowedCommandArgv: [['npm', 'test']], allowWrites: true,
    externalIdempotencyKey: 'decision-123', actionDigest: `sha256:${'a'.repeat(64)}`,
    runner: async (input) => {
      observed = input;
      return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.from('{"type":"result"}\n'), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(observed.command, 'codex');
  assert.equal(observed.stdin, 'Fix the parser test.');
  assert.deepEqual((observed.argv as string[]).slice(0, 3), ['exec', '--ignore-user-config', '--json']);
  assert.equal(observed.completeOnResultJson, true);
  assert.ok((observed.argv as string[]).includes('sandbox_workspace_write.network_access=false'));
  assert.deepEqual(observed.environment, {
    DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'decision-123',
    DHARMA_ACTION_DIGEST: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(result.exitCode, 0);
});

test('Claude task execution exposes only bounded edit tools and registered commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  let argv: string[] = [];
  let completeOnResultJson = false;
  await executeProviderTask({
    provider: 'claude', workspace: root, instructions: 'Repair the test.', timeoutSeconds: 30, allowedCommandArgv: [['npm', 'test']], allowWrites: true,
    runner: async (input) => {
      argv = input.argv;
      completeOnResultJson = input.completeOnResultJson === true;
      return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.ok(argv.includes('--verbose'));
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(!argv.includes('--bare'));
  assert.ok(argv.includes('--no-session-persistence'));
  assert.equal(completeOnResultJson, true);
  assert.ok(argv.includes('Read,Edit,Write,Bash(npm test)'));
  assert.ok(argv.includes('WebFetch,WebSearch'));
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
});

test('Agy task execution creates an isolated project and uses supported plan-mode arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-agy-task-'));
  let observed: Record<string, unknown> = {};
  const result = await executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Summarize this repository.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async (input) => {
      observed = input;
      return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: Buffer.from(JSON.stringify({ status: 'SUCCESS', response: 'Summary' })), stderr: Buffer.alloc(0),
      };
    },
  });
  assert.equal(observed.command, 'agy');
  assert.equal(observed.stdin, '');
  const argv = observed.argv as string[];
  assert.equal(argv[0], '--new-project');
  assert.equal(argv[1], '--print');
  assert.match(String(argv[2]), /Operate only inside the current repository/);
  assert.match(String(argv[2]), /Summarize this repository/);
  assert.deepEqual(argv.slice(3, 5), ['--output-format', 'json']);
  assert.ok(argv.includes('--sandbox'));
  assert.deepEqual(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2), ['--mode', 'plan']);
  assert.ok(argv.includes('--log-file'));
  assert.ok(argv.includes('30s'));
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(result.exitCode, 0);
});

test('Agy accepts structured success despite noisy informational log prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-agy-noisy-success-'));
  const result = await executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Read package metadata.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async (input) => {
      const logFlag = input.argv.indexOf('--log-file');
      await writeFile(String(input.argv[logFlag + 1]), 'ERROR: logging before google.Init: informational startup line; authentication required for optional subsystem\n');
      return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: Buffer.from(JSON.stringify({ status: 'SUCCESS', response: 'ok' })), stderr: Buffer.alloc(0),
      };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, 'SUCCESS');
});

test('Agy fails closed for writes, registered commands, and zero-exit authentication errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-agy-guard-'));
  await assert.rejects(() => executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Edit a file.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: true,
  }), /write tasks are disabled/);
  await assert.rejects(() => executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Run tests.', timeoutSeconds: 30,
    allowedCommandArgv: [['npm', 'test']], allowWrites: false,
  }), /cannot receive registered shell commands/);
  const result = await executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Read the repository.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async () => ({
      exitCode: 0, signal: null, timedOut: false,
      stdout: Buffer.from('You are not logged into Antigravity. Authentication timed out.'), stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /authenticate this device/);

  const denied = await executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Read the repository.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async () => ({
      exitCode: 0, signal: null, timedOut: false,
      stdout: Buffer.alloc(0), stderr: Buffer.from('No output produced because the request was auto-denied.'),
    }),
  });
  assert.equal(denied.exitCode, 1);
  assert.match(denied.stderr, /authenticate this device/);

  const unstructured = await executeProviderTask({
    provider: 'agy', workspace: root, instructions: 'Read the repository.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async () => ({
      exitCode: 0, signal: null, timedOut: false,
      stdout: Buffer.from('Unrecognized provider response'), stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(unstructured.exitCode, 1);
  assert.match(unstructured.stderr, /execution failed/);
});

test('Hermes tasks use safe-mode one-shot execution and fail closed for effects or missing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-hermes-task-'));
  let observed: Record<string, unknown> = {};
  const completed = await executeProviderTask({
    provider: 'hermes', workspace: root, instructions: 'Summarize package metadata.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async (input) => {
      observed = input;
      return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.from('Bounded summary'), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(observed.command, 'hermes');
  assert.equal(observed.stdin, '');
  const argv = observed.argv as string[];
  assert.ok(argv.includes('--ignore-user-config'));
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(argv.includes('--usage-file'));
  assert.ok(argv.includes('--oneshot'));
  assert.match(String(argv.at(-1)), /Summarize package metadata/);
  assert.equal(completed.exitCode, 0);

  await assert.rejects(() => executeProviderTask({
    provider: 'hermes', workspace: root, instructions: 'Edit a file.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: true,
  }), /Hermes write tasks are disabled/);
  await assert.rejects(() => executeProviderTask({
    provider: 'hermes', workspace: root, instructions: 'Run a command.', timeoutSeconds: 30,
    allowedCommandArgv: [['npm', 'test']], allowWrites: false,
  }), /Hermes tasks cannot receive registered shell commands/);

  const missing = await executeProviderTask({
    provider: 'hermes', workspace: root, instructions: 'Read only.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Configure an inference provider/);

  const providerFailure = await executeProviderTask({
    provider: 'hermes', workspace: root, instructions: 'Read only.', timeoutSeconds: 30,
    allowedCommandArgv: [], allowWrites: false,
    runner: async () => ({
      exitCode: 0, signal: null, timedOut: false,
      stdout: Buffer.from('API call failed after 3 retries: Parameter validation failed'), stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(providerFailure.exitCode, 1);
  assert.match(providerFailure.stderr, /inference failed/);
});

test('Hermes task execution pins validated provider and model routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-hermes-model-'));
  const previousProvider = process.env.DHARMA_HERMES_PROVIDER;
  const previousModel = process.env.DHARMA_HERMES_MODEL;
  const previousProject = process.env.DHARMA_HERMES_VERTEX_PROJECT_ID;
  const previousRegion = process.env.DHARMA_HERMES_VERTEX_REGION;
  let argv: string[] = [];
  let environment: Record<string, string> = {};
  process.env.DHARMA_HERMES_PROVIDER = 'vertex';
  process.env.DHARMA_HERMES_MODEL = 'google/gemini-3.7-flash';
  process.env.DHARMA_HERMES_VERTEX_PROJECT_ID = 'dharma-staging-byok-f6f29e';
  process.env.DHARMA_HERMES_VERTEX_REGION = 'global';
  try {
    await executeProviderTask({
      provider: 'hermes', workspace: root, instructions: 'Read package.json.', timeoutSeconds: 30,
      allowedCommandArgv: [], allowWrites: false,
      runner: async (input) => {
        argv = input.argv;
        environment = input.environment || {};
        return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.from('Bounded summary'), stderr: Buffer.alloc(0) };
      },
    });
  } finally {
    if (previousProvider === undefined) delete process.env.DHARMA_HERMES_PROVIDER;
    else process.env.DHARMA_HERMES_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.DHARMA_HERMES_MODEL;
    else process.env.DHARMA_HERMES_MODEL = previousModel;
    if (previousProject === undefined) delete process.env.DHARMA_HERMES_VERTEX_PROJECT_ID;
    else process.env.DHARMA_HERMES_VERTEX_PROJECT_ID = previousProject;
    if (previousRegion === undefined) delete process.env.DHARMA_HERMES_VERTEX_REGION;
    else process.env.DHARMA_HERMES_VERTEX_REGION = previousRegion;
  }
  assert.deepEqual(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 2), ['--provider', 'vertex']);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'google/gemini-3.7-flash']);
  assert.equal(environment.VERTEX_PROJECT_ID, 'dharma-staging-byok-f6f29e');
  assert.equal(environment.VERTEX_REGION, 'global');
});

test('Claude task execution pins a validated configured model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-model-'));
  const previous = process.env.DHARMA_CLAUDE_MODEL;
  let argv: string[] = [];
  process.env.DHARMA_CLAUDE_MODEL = 'claude-sonnet-5';
  try {
    await executeProviderTask({
      provider: 'claude', workspace: root, instructions: 'Read package.json.', timeoutSeconds: 30,
      allowedCommandArgv: [], allowWrites: false,
      runner: async (input) => {
        argv = input.argv;
        return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
  } finally {
    if (previous === undefined) delete process.env.DHARMA_CLAUDE_MODEL;
    else process.env.DHARMA_CLAUDE_MODEL = previous;
  }
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'claude-sonnet-5']);
});

test('Claude task execution rejects an unsafe model selector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-model-'));
  const previous = process.env.DHARMA_CLAUDE_MODEL;
  process.env.DHARMA_CLAUDE_MODEL = 'claude-sonnet-5 --dangerously-skip-permissions';
  try {
    await assert.rejects(() => executeProviderTask({
      provider: 'claude', workspace: root, instructions: 'Read package.json.', timeoutSeconds: 30,
      allowedCommandArgv: [], allowWrites: false,
    }), /DHARMA_CLAUDE_MODEL is invalid/);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_CLAUDE_MODEL;
    else process.env.DHARMA_CLAUDE_MODEL = previous;
  }
});

test('knowledge queries remove write-capable provider tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-readonly-'));
  const observed: Array<{ provider: string; argv: string[] }> = [];
  for (const provider of ['codex', 'claude'] as const) {
    await executeProviderTask({
      provider,
      workspace: root,
      instructions: 'Summarize the repository architecture without changing files.',
      timeoutSeconds: 30,
      allowedCommandArgv: [],
      allowWrites: false,
      runner: async (input) => {
        observed.push({ provider, argv: input.argv });
        return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
  }
  assert.ok(observed[0]?.argv.includes('read-only'));
  assert.equal(observed[0]?.argv.includes('workspace-write'), false);
  const claudeAllowedTools = observed[1]?.argv[observed[1]?.argv.indexOf('--allowedTools') + 1];
  assert.equal(claudeAllowedTools, 'Read');
});

test('provider runner completes on a terminal JSON result without a trailing newline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const result = await defaultProcessRunner({
    command: process.execPath,
    argv: ['-e', 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false}));setInterval(()=>{},1000)'],
    cwd: root,
    stdin: '',
    timeoutMs: 5_000,
    completeOnResultJson: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test('provider runner completes a Codex task on turn.completed without waiting for the wrapper process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-codex-terminal-'));
  const result = await defaultProcessRunner({
    command: process.execPath,
    argv: ['-e', 'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));setInterval(()=>{},1000)'],
    cwd: root,
    stdin: '',
    timeoutMs: 5_000,
    completeOnResultJson: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test('provider runner force-terminates a Codex wrapper that ignores SIGTERM after turn.completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-codex-terminal-escalation-'));
  const result = await defaultProcessRunner({
    command: process.execPath,
    argv: ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));setInterval(()=>{},1000)'],
    cwd: root,
    stdin: '',
    timeoutMs: 5_000,
    completeOnResultJson: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test('provider runner timeout terminates descendant processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-tree-'));
  const childScript = 'setInterval(()=>{},1000)';
  const parentScript = [
    'const {spawn}=require("node:child_process");',
    `const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});`,
    'process.stdout.write(String(child.pid));',
    'setInterval(()=>{},1000);',
  ].join('');
  const result = await defaultProcessRunner({
    command: process.execPath,
    argv: ['-e', parentScript],
    cwd: root,
    stdin: '',
    timeoutMs: 150,
  });
  assert.equal(result.timedOut, true);
  const descendantPid = Number(result.stdout.toString('utf8'));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    try { process.kill(descendantPid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw error;
    }
  }
  assert.equal(alive, false, `descendant process ${descendantPid} survived timeout containment`);
});
