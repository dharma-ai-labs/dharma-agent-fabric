import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createRelayPresence } from './presence.js';
import { parseRelayRequest, relayTarget } from './protocol.js';

const port = Number(process.env.PORT || 8080);
const hqInternalUrl = process.env.DHARMA_HQ_INTERNAL_URL?.trim();
if (!hqInternalUrl) throw new Error('DHARMA_HQ_INTERNAL_URL is required.');
const presence = await createRelayPresence();

const server = createServer((request, response) => {
  if (request.method === 'GET' && (request.url === '/health' || request.url === '/healthz')) {
    const ready = presence.ready();
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: ready, service: 'dharma-agent-fabric-relay', presence: ready ? 'ready' : 'unavailable' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

const sockets = new Set<WebSocket>();
const websocket = new WebSocketServer({ noServer: true, maxPayload: 1_200_000, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/v1/connect') { socket.destroy(); return; }
  websocket.handleUpgrade(request, socket, head, (client) => websocket.emit('connection', client, request));
});

websocket.on('connection', (socket) => {
  sockets.add(socket);
  let lastPresence: { deviceId: string; value: string | null } | null = null;
  let chain = Promise.resolve();
  const ping = setInterval(() => { if (socket.readyState === socket.OPEN) socket.ping(); }, 25_000);
  socket.on('message', (data, binary) => {
    chain = chain.then(async () => {
      let requestId: string | null = null;
      try {
        if (binary) throw new Error('binary_not_supported');
        const message = parseRelayRequest(JSON.parse(data.toString('utf8')));
        requestId = message.requestId;
        const deviceId = message.headers['x-dharma-device-id']!;
        const sessionId = message.headers['x-dharma-session-id']!;
        const value = await presence.touch(deviceId, sessionId);
        lastPresence = { deviceId, value };
        const upstream = await fetch(relayTarget(hqInternalUrl, message), {
          method: message.method, headers: message.headers, body: message.body, signal: AbortSignal.timeout(30_000),
        });
        const body = await upstream.text();
        socket.send(JSON.stringify({ requestId, status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') }, body }));
      } catch (error) {
        socket.send(JSON.stringify({ requestId, status: 400, body: JSON.stringify({ ok: false, error: { code: error instanceof Error ? error.message : 'relay_error', message: 'Relay request was rejected.' } }) }));
      }
    }).catch(() => undefined);
  });
  socket.on('close', () => {
    clearInterval(ping);
    sockets.delete(socket);
    if (lastPresence) void presence.remove(lastPresence.deviceId, lastPresence.value).catch(() => undefined);
  });
  socket.on('error', () => undefined);
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({ ok: true, port })}\n`));

const shutdown = () => {
  for (const socket of sockets) socket.close(1001, 'server_shutdown');
  server.close(() => { void presence.close().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
