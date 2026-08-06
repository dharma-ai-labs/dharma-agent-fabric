#!/usr/bin/env node

import process from 'node:process';
import WebSocket from 'ws';

const origin = String(process.env.AGENT_FABRIC_RELAY_ORIGIN || '').replace(/\/$/, '');
const devices = positiveInteger(process.env.AGENT_FABRIC_LOAD_DEVICES, 1_000);
const timeoutMs = positiveInteger(process.env.AGENT_FABRIC_LOAD_TIMEOUT_MS, 120_000);

if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
  throw new Error('AGENT_FABRIC_RELAY_ORIGIN must be a credential-free HTTPS origin.');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}.`);
  }
  return parsed;
}

function connectionProbe(websocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('live_relay_connection_timeout'));
    }, timeoutMs);
    let opened = false;

    const finish = (error, value) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };

    socket.once('open', () => {
      opened = true;
      socket.send('{}');
    });
    socket.once('message', (raw) => {
      try {
        const response = JSON.parse(raw.toString('utf8'));
        const body = JSON.parse(response.body);
        if (response.status !== 400 || body?.error?.code !== 'invalid_request_id') {
          finish(new Error(`unexpected_live_relay_response:${response.status}:${body?.error?.code}`));
          return;
        }
        finish(null, { opened, failClosed: true });
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', (code) => {
      if (!opened && code !== 1000) finish(new Error(`live_relay_closed_${code}`));
    });
  });
}

async function runWave(websocketUrl) {
  const results = await Promise.all(Array.from({ length: devices }, () => connectionProbe(websocketUrl)));
  return {
    opened: results.filter((result) => result.opened).length,
    failClosed: results.filter((result) => result.failClosed).length,
  };
}

const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15_000) });
const healthBody = await health.json();
if (health.status !== 200 || healthBody?.ok !== true || healthBody?.presence !== 'ready') {
  throw new Error(`relay_health_failed:${health.status}`);
}

const websocketUrl = `${origin.replace(/^https:/, 'wss:')}/v1/connect`;
const startedAt = Date.now();
const initial = await runWave(websocketUrl);
const reconnect = await runWave(websocketUrl);

if (initial.opened !== devices || initial.failClosed !== devices
  || reconnect.opened !== devices || reconnect.failClosed !== devices) {
  throw new Error('live_relay_load_proof_incomplete');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  origin,
  devices,
  health: { status: health.status, presence: healthBody.presence },
  initial,
  reconnect,
  elapsedMs: Date.now() - startedAt,
}, null, 2)}\n`);
