import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodexAppServerTransport } from './codexAppServerTransport.js';

const fakeServer = `
const readline = require('node:readline');
const mode = process.argv[1];
let experimentalApi = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    experimentalApi = message.params.capabilities?.experimentalApi === true;
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }) + '\\n');
  } else if (message.method === 'ping') {
    if (mode === 'handshake') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { experimentalApi } }) + '\\n');
      return;
    }
    if (mode === 'exit') process.exit(0);
    if (mode === 'timeout') return;
    if (mode === 'oversized') {
      process.stdout.write('x'.repeat(2_048));
      return;
    }
    if (mode === 'request') {
      process.stdout.write(JSON.stringify({ id: 100, method: 'item/commandExecution/requestApproval', params: {} }) + '\\n');
      return;
    }
    if (mode === 'tool') {
      process.stdout.write(JSON.stringify({ id: 'call-1', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'dharma_peer_ask', arguments: {} } }) + '\\n');
      global.pendingPing = message.id;
      return;
    }
    if (mode === 'tool-deferred' || mode === 'setup-deferred') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { dispatched: true } }) + '\\n');
      process.stdout.write(JSON.stringify({ id: 'call-1', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: mode === 'setup-deferred' ? 'dharma_setup_reference' : 'dharma_peer_ask', arguments: {} } }) + '\\n');
      return;
    }
    if (mode === 'error') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: 403, message: 'private data' } }) + '\\n');
      return;
    }
    const notification = JSON.stringify({ method: 'turn/completed', params: { threadId: 'test' } }) + '\\n';
    process.stdout.write(notification.slice(0, 12));
    process.stdout.write(notification.slice(12));
    process.stdout.write(JSON.stringify({ id: message.id, result: { pong: message.params.value } }) + '\\n');
  } else if (message.id === 'call-1' && message.result) {
    if (mode === 'tool-deferred' || mode === 'setup-deferred') {
      process.stdout.write(JSON.stringify({ method: 'tool/completed', params: message.result }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ id: global.pendingPing, result: message.result }) + '\\n');
  }
});
`;

function open(mode: string, options: { maximumFrameBytes?: number; requestTimeoutMs?: number; toolCallTimeoutMs?: number; setupApprovalTimeoutMs?: number; experimentalApi?: boolean } = {}) {
  return openCodexAppServerTransport({
    command: process.execPath, argv: ['-e', fakeServer, mode], cwd: process.cwd(),
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    maximumFrameBytes: options.maximumFrameBytes,
    toolCallTimeoutMs: options.toolCallTimeoutMs,
    setupApprovalTimeoutMs: options.setupApprovalTimeoutMs,
    ...{ experimentalApi: options.experimentalApi },
  });
}

test('closing an owned Linux launcher also stops its native descendant with inherited pipes', { skip: process.platform !== 'linux' }, async () => {
  const native = `${fakeServer}\nsetInterval(() => {}, 1000);`;
  const launcher = `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(native)},'normal'],{stdio:['inherit','inherit','inherit']});
setInterval(()=>{},1000);
`;
  const transport = await openCodexAppServerTransport({ command: process.execPath,
    argv: ['-e', launcher], cwd: process.cwd(), requestTimeoutMs: 1000 });
  const started = Date.now();
  await transport.close();
  assert.ok(Date.now() - started < 4000);
  await assert.rejects(transport.request('ping', {}), /codex_app_server_unavailable/);
});

test('a bounded tool callback has a separate deadline from completed RPC requests', async () => {
  const transport = await open('tool-deferred', { requestTimeoutMs: 1000, toolCallTimeoutMs: 2500 });
  try {
    const completion = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('callback completion missing')), 3500);
      transport.onNotification((event: any) => {
        if (event.method === 'tool/completed') { clearTimeout(timer); resolve(event.params); }
      });
    });
    transport.onToolCall(async () => {
      await new Promise(resolve => setTimeout(resolve, 1300));
      return { success: true, contentItems: [{ type: 'inputText', text: 'bounded queued receipt' }] };
    });
    assert.deepEqual(await transport.request('ping', {}), { dispatched: true });
    assert.deepEqual(await completion, { success: true,
      contentItems: [{ type: 'inputText', text: 'bounded queued receipt' }] });
  } finally { await transport.close(); }
});

test('tool expiry cancels its admission context and never returns a late result', async () => {
  const transport = await open('tool-deferred', { requestTimeoutMs: 1000, toolCallTimeoutMs: 30 });
  let cancelled = false, lateResults = 0;
  try {
    transport.onNotification((event: any) => { if (event.method === 'tool/completed') lateResults++; });
    transport.onToolCall(async (_params, context) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      cancelled = context?.signal.aborted === true;
      return { success: true, contentItems: [{ type: 'inputText', text: 'late result' }] };
    });
    assert.deepEqual(await transport.request('ping', {}), { dispatched: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(cancelled, true);
    assert.equal(lateResults, 0);
    await assert.rejects(transport.request('ping', {}), /codex_app_server_unavailable/);
  } finally { await transport.close(); }
});

test('invalid callback deadlines fail before launching a provider', async () => {
  for (const toolCallTimeoutMs of [0, -1, 1.5, 60001]) {
    await assert.rejects(open('normal', { toolCallTimeoutMs }), /codex_app_server_launch_invalid/);
  }
});

test('recipient approval wait is limited to the setup tool and cannot extend peer execution', async () => {
  for (const mode of ['setup-deferred', 'tool-deferred']) {
    const transport = await open(mode, {experimentalApi: true, toolCallTimeoutMs: 30, setupApprovalTimeoutMs: 500});
    let completed = false, cancelled = false;
    try {
      transport.onNotification((event: any) => {if (event.method === 'tool/completed') completed = true;});
      transport.onToolCall(async (_params, context) => {
        assert.ok(context);
        await new Promise(done => setTimeout(done, 100)); cancelled = context.signal.aborted;
        return {success: true, contentItems: [{type: 'inputText', text: 'receipt'}]};
      });
      await transport.request('ping', {});
      await new Promise(done => setTimeout(done, 180));
      assert.equal(completed, mode === 'setup-deferred');
      assert.equal(cancelled, mode === 'tool-deferred');
    } finally {await transport.close();}
  }
});

test('setup-only approval deadline remains finite and requires the native experimental protocol', async () => {
  for (const setupApprovalTimeoutMs of [0, -1, 1.5, 900001]) {
    await assert.rejects(open('normal', {experimentalApi: true, setupApprovalTimeoutMs}), /codex_app_server_launch_invalid/);
  }
  await assert.rejects(open('normal', {setupApprovalTimeoutMs: 900000}), /codex_app_server_launch_invalid/);
  const transport = await open('normal', {experimentalApi: true, setupApprovalTimeoutMs: 900000});
  await transport.close();
});

test('normal transport close cancels an active tool context', async () => {
  const transport = await open('tool-deferred');
  let signal: AbortSignal | undefined;
  transport.onToolCall(async (_params, context) => {
    signal = context?.signal;
    return new Promise(() => {});
  });
  await transport.request('ping', {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(signal);
  await transport.close();
  assert.equal(signal.aborted, true);
});

test('stdio transport initializes, parses fragmented notifications, and matches responses', async () => {
  const transport = await open('normal');
  const lifetime = transport.signal;
  try {
    assert.equal(lifetime.aborted, false);
    const seen: unknown[] = [];
    const unsubscribe = transport.onNotification(event => seen.push(event));
    assert.deepEqual(await transport.request('ping', { value: 'first' }), { pong: 'first' });
    assert.deepEqual(await transport.request('ping', { value: 'second' }), { pong: 'second' });
    assert.equal(seen.length, 2);
    unsubscribe();
  } finally { await transport.close(); }
  assert.equal(lifetime.aborted, true);
  assert.equal(transport.signal, lifetime);
  await transport.close();
  await assert.rejects(transport.request('ping', {}), /codex_app_server_unavailable/);
});

test('experimental permission profiles require explicit transport capability opt-in', async () => {
  for (const enabled of [undefined, false, true]) {
    const transport = await open('handshake', { experimentalApi: enabled });
    try { assert.deepEqual(await transport.request('ping', {}), { experimentalApi: enabled === true }); }
    finally { await transport.close(); }
  }
});

test('stdio transport rejects provider errors without exposing provider text', async () => {
  const transport = await open('error');
  try {
    await assert.rejects(transport.request('ping', {}), /codex_app_server_request_failed:ping:403/);
  } finally { await transport.close(); }
});

test('stdio transport fails closed on oversized frames and provider-originated requests', async () => {
  for (const [mode, expected] of [
    ['oversized', /codex_app_server_frame_too_large/],
    ['request', /codex_app_server_unexpected_request/],
  ] as const) {
    const transport = await open(mode, { maximumFrameBytes: 1_024 });
    try {
      await assert.rejects(transport.request('ping', {}), expected);
      assert.equal(transport.signal.aborted, true);
    }
    finally { await transport.close(); }
  }
});

test('stdio transport bounds a stalled provider request', async () => {
  const transport = await open('timeout');
  try { await assert.rejects(transport.request('ping', {}), /codex_app_server_request_timeout:ping/); }
  finally { await transport.close(); }
});

test('stdio transport fails a request when the provider exits', async () => {
  const transport = await open('exit');
  try { await assert.rejects(transport.request('ping', {}), /codex_app_server_closed|codex_app_server_write_failed/); }
  finally { await transport.close(); }
});

test('stdio transport rejects an oversized outbound request', async () => {
  const transport = await open('normal');
  try {
    await assert.rejects(transport.request('ping', { value: 'x'.repeat(132_000) }),
      /codex_app_server_request_too_large/);
  } finally { await transport.close(); }
});

test('explicit dynamic-tool handler receives a string request ID without granting approvals', async () => {
  const transport = await open('tool');
  try {
    const remove = transport.onToolCall(async params => ({ success: params.tool === 'dharma_peer_ask',
      contentItems: [{ type: 'inputText', text: 'bounded receipt' }] }));
    assert.deepEqual(await transport.request('ping', {}), { success: true,
      contentItems: [{ type: 'inputText', text: 'bounded receipt' }] });
    remove();
    await assert.rejects(transport.request('ping', {}), /codex_app_server_unexpected_request/);
  } finally { await transport.close(); }
});

test('dynamic-tool handler failure cannot disclose its exception', async () => {
  const transport = await open('tool');
  try {
    transport.onToolCall(async () => { throw new Error('private exception'); });
    assert.deepEqual(await transport.request('ping', {}), { success: false,
      contentItems: [{ type: 'inputText', text: 'codex_session_tool_unavailable' }] });
  } finally { await transport.close(); }
});

test('registering tools does not authorize a provider approval request', async () => {
  const transport = await open('request');
  let called = false;
  try {
    transport.onToolCall(async () => { called = true; return { success: true, contentItems: [] }; });
    await assert.rejects(transport.request('ping', {}), /codex_app_server_unexpected_request/);
    assert.equal(called, false);
  } finally { await transport.close(); }
});

test('uncertain tool work terminates dispatch, rather than replaying a request', async () => {
  const transport = await open('tool');
  let called = 0;
  try {
    transport.onToolCall(async () => { called++; return new Promise(() => {}); });
    await assert.rejects(transport.request('ping', {}), /codex_app_server_request_timeout:ping|codex_app_server_tool_unconfirmed/);
    assert.equal(called, 1);
  } finally { await transport.close(); }
});

test('duplicate provider request IDs cannot repeat a peer side effect', async () => {
  const transport = await open('tool');
  let called = 0;
  try {
    transport.onToolCall(async () => { called++; return { success: true,
      contentItems: [{ type: 'inputText', text: 'queued' }] }; });
    await transport.request('ping', {});
    await assert.rejects(transport.request('ping', {}), /codex_app_server_unexpected_request/);
    assert.equal(called, 1);
  } finally { await transport.close(); }
});
