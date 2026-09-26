import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CodexAppServerTransport } from './codexAppServerSession.js';

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export interface CodexStdioTransport extends CodexAppServerTransport {
  close(): Promise<void>;
}

export async function openCodexAppServerTransport(input: {
  command: string;
  argv: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maximumFrameBytes?: number;
  experimentalApi?: boolean;
}): Promise<CodexStdioTransport> {
  const timeoutMs = input.requestTimeoutMs ?? 15_000;
  const maximumFrameBytes = input.maximumFrameBytes ?? 5_000_000;
  if (!isAbsolute(input.cwd) || !input.command || !Array.isArray(input.argv)
    || input.argv.some(arg => typeof arg !== 'string')
    || (input.experimentalApi !== undefined && typeof input.experimentalApi !== 'boolean')
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isInteger(maximumFrameBytes) || maximumFrameBytes < 1_024 || maximumFrameBytes > 5_000_000) {
    throw new Error('codex_app_server_launch_invalid');
  }
  const child = spawn(input.command, input.argv, {
    cwd: input.cwd, env: input.environment ?? process.env,
    shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.resume();
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(event: unknown) => void>();
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let stopped = false;
  let closed = false;
  const processClosed = new Promise<void>(resolve => child.once('close', () => {
    closed = true;
    resolve();
  }));

  function fail(reason: string) {
    if (stopped) return;
    stopped = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
    child.kill();
  }

  function send(message: Record<string, unknown>) {
    if (stopped || !child.stdin.writable) throw new Error('codex_app_server_unavailable');
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > 131_072) throw new Error('codex_app_server_request_too_large');
    child.stdin.write(frame);
  }

  function acceptFrame(frame: Buffer) {
    if (frame.length > maximumFrameBytes) {
      fail('codex_app_server_frame_too_large');
      return;
    }
    let message: unknown;
    try { message = JSON.parse(frame.toString('utf8')); }
    catch { fail('codex_app_server_frame_invalid'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fail('codex_app_server_frame_invalid');
      return;
    }
    const value = message as Record<string, unknown>;
    if (typeof value.id === 'number') {
      if (typeof value.method === 'string') {
        fail('codex_app_server_unexpected_request');
        return;
      }
      const entry = pending.get(value.id);
      if (!entry) return;
      pending.delete(value.id);
      clearTimeout(entry.timer);
      if (value.error != null) {
        const code = typeof value.error === 'object' && value.error !== null
          ? (value.error as Record<string, unknown>).code : null;
        entry.reject(new Error(`codex_app_server_request_failed:${entry.method}:${String(code ?? 'unknown')}`));
      } else if ('result' in value) entry.resolve(value.result);
      else entry.reject(new Error('codex_app_server_response_invalid'));
      return;
    }
    if (typeof value.method !== 'string' || value.id != null) {
      fail('codex_app_server_frame_invalid');
      return;
    }
    for (const listener of listeners) {
      try { listener(value); } catch { /* A listener cannot break transport framing. */ }
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const lineEnd = buffer.indexOf(10);
      if (lineEnd < 0) break;
      const frame = buffer.subarray(0, lineEnd);
      buffer = buffer.subarray(lineEnd + 1);
      acceptFrame(frame);
      if (stopped) return;
    }
    if (buffer.length > maximumFrameBytes) fail('codex_app_server_frame_too_large');
  });
  child.stdin.on('error', () => fail('codex_app_server_write_failed'));
  child.stdout.on('error', () => fail('codex_app_server_read_failed'));
  child.stderr.on('error', () => fail('codex_app_server_stderr_failed'));
  child.on('error', () => fail('codex_app_server_spawn_failed'));
  child.on('close', () => fail('codex_app_server_closed'));

  const transport: CodexStdioTransport = {
    request(method, params) {
      if (!method || !params || typeof params !== 'object') {
        return Promise.reject(new Error('codex_app_server_request_invalid'));
      }
      if (stopped) return Promise.reject(new Error('codex_app_server_unavailable'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex_app_server_request_timeout:${method}`));
          fail('codex_app_server_request_timeout');
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try { send({ id, method, params }); }
        catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
          fail('codex_app_server_write_failed');
        }
      });
    },
    onNotification(listener) {
      if (stopped) throw new Error('codex_app_server_unavailable');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      if (!stopped) {
        stopped = true;
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('codex_app_server_closed'));
        }
        pending.clear();
      }
      child.stdin.end();
      if (closed) return;
      let timer: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        processClosed.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!graceful) child.kill('SIGKILL');
      timer = undefined;
      const finished = await Promise.race([
        processClosed.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!finished) throw new Error('codex_app_server_close_timeout');
    },
  };
  try {
    await transport.request('initialize', {
      clientInfo: { name: 'dharma-agent-fabric-bridge', title: 'Dharma Agent Fabric Bridge', version: '0.0.0' },
      ...(input.experimentalApi === true ? { capabilities: { experimentalApi: true } } : {}),
    });
    send({ method: 'initialized', params: {} });
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  }
}
