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
    if (mode === 'error') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: 403, message: 'private data' } }) + '\\n');
      return;
    }
    const notification = JSON.stringify({ method: 'turn/completed', params: { threadId: 'test' } }) + '\\n';
    process.stdout.write(notification.slice(0, 12));
    process.stdout.write(notification.slice(12));
    process.stdout.write(JSON.stringify({ id: message.id, result: { pong: message.params.value } }) + '\\n');
  }
});
`;

function open(mode: string, options: { maximumFrameBytes?: number; requestTimeoutMs?: number; experimentalApi?: boolean } = {}) {
  return openCodexAppServerTransport({
    command: process.execPath, argv: ['-e', fakeServer, mode], cwd: process.cwd(),
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    maximumFrameBytes: options.maximumFrameBytes,
    ...{ experimentalApi: options.experimentalApi },
  });
}

test('stdio transport initializes, parses fragmented notifications, and matches responses', async () => {
  const transport = await open('normal');
  try {
    const seen: unknown[] = [];
    const unsubscribe = transport.onNotification(event => seen.push(event));
    assert.deepEqual(await transport.request('ping', { value: 'first' }), { pong: 'first' });
    assert.deepEqual(await transport.request('ping', { value: 'second' }), { pong: 'second' });
    assert.equal(seen.length, 2);
    unsubscribe();
  } finally { await transport.close(); }
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
    try { await assert.rejects(transport.request('ping', {}), expected); }
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
