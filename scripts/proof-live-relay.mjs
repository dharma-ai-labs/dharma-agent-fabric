import process from 'node:process';
import WebSocket from 'ws';

const origin = String(process.env.AGENT_FABRIC_RELAY_ORIGIN || '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
  throw new Error('AGENT_FABRIC_RELAY_ORIGIN must be a credential-free HTTPS origin.');
}

const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15_000) });
const healthBody = await health.json();
if (health.status !== 200 || healthBody?.ok !== true || healthBody?.presence !== 'ready') {
  throw new Error(`relay_health_failed:${health.status}`);
}

const websocketUrl = `${origin.replace(/^https:/, 'wss:')}/v1/connect`;
const rejection = await new Promise((resolve, reject) => {
  const socket = new WebSocket(websocketUrl);
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error('relay_websocket_timeout'));
  }, 15_000);
  socket.once('open', () => socket.send('{}'));
  socket.once('message', (data) => {
    clearTimeout(timer);
    try {
      const message = JSON.parse(data.toString('utf8'));
      const body = JSON.parse(message.body);
      resolve({ status: message.status, code: body?.error?.code });
    } catch (error) {
      reject(error);
    } finally {
      socket.close();
    }
  });
  socket.once('error', reject);
});

if (rejection.status !== 400 || rejection.code !== 'invalid_request_id') {
  throw new Error(`relay_fail_closed_proof_failed:${JSON.stringify(rejection)}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  health: { status: health.status, presence: healthBody.presence },
  websocket: { upgraded: true, unsignedEnvelopeStatus: rejection.status, unsignedEnvelopeCode: rejection.code },
})}\n`);
