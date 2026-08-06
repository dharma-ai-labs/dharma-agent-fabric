#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const devices = positiveInteger(process.env.AGENT_FABRIC_LOAD_DEVICES, 1_000);
const messagesPerDevice = positiveInteger(process.env.AGENT_FABRIC_LOAD_MESSAGES, 10);
const reconnectDevices = positiveInteger(process.env.AGENT_FABRIC_LOAD_RECONNECT_DEVICES, devices);
const timeoutMs = positiveInteger(process.env.AGENT_FABRIC_LOAD_TIMEOUT_MS, 120_000);

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received ${value}.`);
  return parsed;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve listening port.');
  return address.port;
}

async function closeServer(server) {
  server.close();
  await once(server, 'close').catch(() => undefined);
}

function relayEnvelope(deviceId, sessionId, sequence) {
  const requestId = randomUUID();
  return {
    requestId,
    method: 'POST',
    pathname: '/api/v1/orgs/org_agentfabricload/agent-fabric/sessions',
    headers: {
      'content-type': 'application/json',
      'x-dharma-device-id': deviceId,
      'x-dharma-session-id': sessionId,
      'x-dharma-message-id': requestId,
      'x-dharma-timestamp': new Date().toISOString(),
      'x-dharma-nonce': Buffer.from(randomUUID()).toString('base64url'),
      'x-dharma-sequence': String(sequence),
      'x-dharma-signature': 'A'.repeat(86),
    },
    body: JSON.stringify({ connectionId: randomUUID(), durableCursor: null, relayVersion: 'load-proof' }),
  };
}

function runDevice(relayUrl, messageCount) {
  return new Promise((resolve, reject) => {
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const socket = new WebSocket(relayUrl, { perMessageDeflate: false });
    let acknowledged = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('device_timeout')), timeoutMs);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(acknowledged);
    };

    socket.once('open', () => {
      for (let sequence = 1; sequence <= messageCount; sequence += 1) {
        socket.send(JSON.stringify(relayEnvelope(deviceId, sessionId, sequence)));
      }
    });
    socket.on('message', (raw) => {
      try {
        const response = JSON.parse(raw.toString('utf8'));
        if (response.status !== 200) finish(new Error(`relay_status_${response.status}`));
        else if (++acknowledged === messageCount) finish();
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', finish);
    socket.once('close', (code) => {
      if (!settled && code !== 1000) finish(new Error(`relay_closed_${code}`));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Relay exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Relay did not become healthy.');
}

const upstream = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
});
const upstreamPort = await listen(upstream);

const relayProbe = createServer();
const relayPort = await listen(relayProbe);
await closeServer(relayProbe);

const relay = spawn(process.execPath, ['apps/relay-gateway/dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(relayPort),
    DHARMA_HQ_INTERNAL_URL: `http://127.0.0.1:${upstreamPort}`,
    AGENT_FABRIC_PRESENCE_REQUIRED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayStderr = '';
relay.stderr.on('data', (chunk) => { relayStderr += chunk.toString('utf8'); });

const startedAt = Date.now();
try {
  await waitForHealth(`http://127.0.0.1:${relayPort}/health`, relay);
  const relayUrl = `ws://127.0.0.1:${relayPort}/v1/connect`;
  const first = await Promise.all(Array.from({ length: devices }, () => runDevice(relayUrl, messagesPerDevice)));
  const reconnect = await Promise.all(Array.from({ length: reconnectDevices }, () => runDevice(relayUrl, 1)));
  const acknowledgements = first.reduce((sum, value) => sum + value, 0) + reconnect.reduce((sum, value) => sum + value, 0);
  const expected = devices * messagesPerDevice + reconnectDevices;
  if (acknowledgements !== expected) throw new Error(`Expected ${expected} acknowledgements; received ${acknowledgements}.`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    devices,
    messagesPerDevice,
    reconnectDevices,
    acknowledgements,
    elapsedMs: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  relay.kill('SIGTERM');
  await Promise.race([once(relay, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await closeServer(upstream);
  if (relay.exitCode && relay.exitCode !== 0 && relay.exitCode !== 143) {
    process.stderr.write(relayStderr);
  }
}
