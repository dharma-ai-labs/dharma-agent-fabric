import assert from 'node:assert/strict';
import test from 'node:test';
import { namedCodexEnvironment } from './namedCodexEnvironment.js';

test('named Codex preserves existing local protected-store and bounded proxy transports', () => {
  const source = { HOME: '/home/member', CODEX_HOME: '/home/member/codex', PATH: '/usr/bin',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/ef/current/bus', XDG_RUNTIME_DIR: '/run/ef/current',
    HTTP_PROXY: 'http://127.0.0.1:8080', HTTPS_PROXY: 'http://127.0.0.1:8080',
    WS_PROXY: 'http://localhost:8080', WSS_PROXY: 'http://[::1]:8080',
    OPENAI_API_KEY: 'not-forwarded', DHARMA_HOME: '/home/member/device',
    NODE_OPTIONS: '--require=untrusted-code', KEYRING_PASSWORD: 'not-forwarded' };
  const env = namedCodexEnvironment(source);
  for (const key of ['CODEX_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'WS_PROXY', 'WSS_PROXY'] as const) {
    assert.equal(env[key], source[key]);
  }
  for (const key of ['OPENAI_API_KEY', 'DHARMA_HOME', 'NODE_OPTIONS', 'KEYRING_PASSWORD']) assert.equal(env[key], undefined);
  assert.equal(source.NODE_OPTIONS, '--require=untrusted-code');
});

test('absent session transports do not create a login, proxy or alternate store', () => {
  const env = namedCodexEnvironment({ HOME: '/home/member', PATH: '/usr/bin' });
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY']) assert.equal(env[key], undefined);
});

test('remote, malformed and compound OS session addresses are rejected', () => {
  for (const value of ['tcp:host=foreign', 'unix:path=/run/ef/bus;tcp:host=foreign', 'unix:path=/run/../foreign/bus', 'unix:path=relative', 'unix:path=/run/ef/bus\n']) {
    assert.throws(() => namedCodexEnvironment({ DBUS_SESSION_BUS_ADDRESS: value }), /named_session_os_transport_invalid/);
  }
  for (const value of ['relative', '/run/../foreign', '/run/ef\n']) {
    assert.throws(() => namedCodexEnvironment({ XDG_RUNTIME_DIR: value }), /named_session_os_transport_invalid/);
  }
});

test('proxy settings cannot transmit credentials or broaden the qualified network route', () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY']) {
    for (const value of ['http://foreign:8080', 'http://user:password@127.0.0.1:8080', 'http://127.0.0.1:8080/?token=value', 'http://127.0.0.1:8080/#value', 'file:///private', 'not a URL']) {
      assert.throws(() => namedCodexEnvironment({ [key]: value }), /named_session_proxy_scope_invalid/);
    }
  }
});
