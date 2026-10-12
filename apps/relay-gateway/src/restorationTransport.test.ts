import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();assert.ok(address && typeof address === 'object');return address.port;
}

test('actual gateway forwards signed restoration metadata and blobs but rejects extra authority', { timeout: 30000 }, async t => {
  const keys = generateKeyPairSync('ed25519'), deviceId = randomUUID(), sessionId = randomUUID();
  const upstreamPaths: string[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      assert.ok(request.method === 'GET' || request.method === 'POST');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'POST') {
        assert.ok(request.url?.endsWith('/package-candidates/fence'));
        assert.equal(JSON.parse(body).schema, 'dharma.repository-candidate-fence/v1');
      }
      assert.equal(request.headers.authorization, undefined);assert.equal(request.headers.cookie, undefined);
      const payload = { bodyHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, deviceId,
        messageId: request.headers['x-dharma-message-id'], method: request.method,
        nonce: request.headers['x-dharma-nonce'], organizationId: 'org_fixture', pathname: request.url,
        sequence: Number(request.headers['x-dharma-sequence']), sessionId,
        timestamp: request.headers['x-dharma-timestamp'] };
      assert.ok(verify(null, Buffer.from(JSON.stringify(payload)), keys.publicKey,
        Buffer.from(String(request.headers['x-dharma-signature']), 'base64url')));
      upstreamPaths.push(request.url!);
      response.writeHead(200, { 'content-type': 'application/json' });response.end(JSON.stringify({ ok: true }));
    } catch { response.writeHead(500);response.end('{}'); }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise<void>(done => { upstream.close(() => done());upstream.closeAllConnections(); }));
  const reservation = createServer(), relayPort = await listen(reservation);
  await new Promise<void>(done => reservation.close(() => done()));
  // An isolated process with no inherited service credentials or production endpoints.
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), NODE_ENV: 'test',
      PORT: String(relayPort), DHARMA_HQ_INTERNAL_URL: `http://127.0.0.1:${upstreamPort}` },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const terminal = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');await terminal; });
  await new Promise<void>((done, reject) => {
    let output = '';
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(0, 2048); });
    const details = () => JSON.stringify({ stdout: output.slice(0, 512), stderr: diagnostic.slice(0, 512) });
    const timer = setTimeout(() => reject(new Error(`synthetic_gateway_start_timeout: ${details()}`)), 10000);
    child.once('error', error => { clearTimeout(timer);reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer);reject(new Error(`synthetic_gateway_start_failed: ${JSON.stringify({ code, signal })} ${details()}`)); });
    child.stdout.on('data', bytes => {
      output = (output + String(bytes)).slice(0, 2048);
      if (output.includes(`"port":${relayPort}`)) { clearTimeout(timer);done(); }
    });
  });
  const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/connect`);
  t.after(() => { if (socket.readyState < WebSocket.CLOSING) socket.close(); });
  await new Promise<void>((done, reject) => { socket.addEventListener('open', () => done(), { once: true });
    socket.addEventListener('error', () => reject(new Error('synthetic_gateway_connect_failed')), { once: true }); });
  let sequence = 0;
  const send = async (pathname: string, method = 'GET', body = '') => {
    const messageId = randomUUID(), timestamp = new Date().toISOString(), nonce = randomBytes(24).toString('base64url');
    const payload = { bodyHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, deviceId,
      messageId, method, nonce, organizationId: 'org_fixture', pathname, sequence: ++sequence, sessionId, timestamp };
    const result = new Promise<{ status: number; body: string }>(done => {
      socket.addEventListener('message', event => done(JSON.parse(String(event.data))), { once: true });
    });
    socket.send(JSON.stringify({ requestId: messageId, method, pathname, body, headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      'x-dharma-device-id': deviceId, 'x-dharma-session-id': sessionId, 'x-dharma-message-id': messageId,
      'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce, 'x-dharma-sequence': String(sequence),
      'x-dharma-signature': sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64url'),
      authorization: 'synthetic-not-forwarded', cookie: 'synthetic-not-forwarded',
    } }));
    return result;
  };
  const prefix = `/api/v1/orgs/org_fixture/agent-fabric/repository-agents/${randomUUID()}/source-inventory`;
  const metadata = `${prefix}?workspaceId=${randomUUID()}&restoration=true`;
  const blob = `${prefix}/${randomUUID()}/blobs/sha256%3A${'a'.repeat(64)}?workspaceId=${randomUUID()}&path=docs%2Fstable.md&restoration=true`;
  const operation = `${prefix.replace(/\/source-inventory$/, '/package-candidates')}?workspaceId=${randomUUID()}&operationId=sha256%3A${'c'.repeat(64)}`;
  for (const pathname of [metadata, `${metadata}&restorationOperationId=sha256%3A${'b'.repeat(64)}`, blob, operation]) {
    const response = await send(pathname);assert.equal(response.status, 200);assert.equal(JSON.parse(response.body).ok, true);
  }
  const denied = await send(`${metadata}&admin=true`);
  assert.equal(denied.status, 400);assert.equal(JSON.parse(denied.body).error.code, 'route_not_allowed');
  const fence = prefix.replace(/\/source-inventory$/, '/package-candidates/fence');
  assert.equal((await send(fence, 'POST', JSON.stringify({ schema: 'dharma.repository-candidate-fence/v1' }))).status, 200);
  assert.equal((await send(fence, 'POST', 'x'.repeat(4097))).status, 400);
  assert.equal(upstreamPaths.length, 5);
});
