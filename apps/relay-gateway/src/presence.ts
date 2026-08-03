import { createClient } from 'redis';

export interface RelayPresenceConfig {
  required: boolean;
  host: string | null;
  port: number;
  tls: boolean;
  ca: string | null;
}

export function relayPresenceConfig(env: NodeJS.ProcessEnv = process.env): RelayPresenceConfig {
  const required = env.AGENT_FABRIC_PRESENCE_REQUIRED === 'true';
  const host = env.REDIS_HOST?.trim() || null;
  const port = Number(env.REDIS_PORT || 6379);
  const tls = env.REDIS_TLS === 'true';
  const ca = env.REDIS_CA_CERT?.replace(/\\n/g, '\n').trim() || null;
  if (required && !host) throw new Error('REDIS_HOST is required when presence is mandatory.');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('REDIS_PORT is invalid.');
  if (required && tls && !ca) throw new Error('REDIS_CA_CERT is required for mandatory TLS presence.');
  return { required, host, port, tls, ca };
}

export async function createRelayPresence(config = relayPresenceConfig()) {
  if (!config.host) {
    return {
      ready: () => !config.required,
      touch: async () => null,
      remove: async () => undefined,
      close: async () => undefined,
    };
  }
  const client = createClient({
    socket: config.tls
      ? {
          host: config.host, port: config.port, tls: true, ca: config.ca || undefined,
          reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
        }
      : {
          host: config.host, port: config.port,
          reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
        },
  });
  client.on('error', (error) => process.stderr.write(`${JSON.stringify({ level: 'error', event: 'presence.redis_error', message: error.message })}\n`));
  await client.connect();
  return {
    ready: () => client.isReady,
    async touch(deviceId: string, sessionId: string) {
      const key = `agent-fabric:presence:${deviceId}`;
      const value = JSON.stringify({ sessionId, touchedAt: new Date().toISOString() });
      await client.set(key, value, { expiration: { type: 'EX', value: 90 } });
      return value;
    },
    async remove(deviceId: string, expected: string | null) {
      if (!expected || !client.isReady) return;
      await client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [`agent-fabric:presence:${deviceId}`], arguments: [expected] },
      );
    },
    async close() { if (client.isOpen) await client.quit(); },
  };
}
