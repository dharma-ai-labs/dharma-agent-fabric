import { posix } from 'node:path';
import { providerProcessEnvironment } from '@dharma-ai-labs/agent-fabric-provider-adapters';

// A native provider needs its existing OS session, not exported credentials.
export function namedCodexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = providerProcessEnvironment(source);
  if (source.DBUS_SESSION_BUS_ADDRESS !== undefined) {
    const address = source.DBUS_SESSION_BUS_ADDRESS;
    const match = /^unix:path=(\/[A-Za-z0-9_.\/-]+)$(?![\s\S])/.exec(address);
    if (!match || posix.resolve(match[1]!) !== match[1]) throw new Error('named_session_os_transport_invalid');
    environment.DBUS_SESSION_BUS_ADDRESS = address;
  }
  if (source.XDG_RUNTIME_DIR !== undefined) {
    const path = source.XDG_RUNTIME_DIR;
    if (!posix.isAbsolute(path) || !/^\/[A-Za-z0-9_.\/-]+$(?![\s\S])/.test(path) || posix.resolve(path) !== path) {
      throw new Error('named_session_os_transport_invalid');
    }
    environment.XDG_RUNTIME_DIR = path;
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY']) {
    const value = source[key];
    if (value === undefined) continue;
    let proxy: URL;
    try {
      if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('invalid');
      proxy = new URL(value);
    } catch { throw new Error('named_session_proxy_scope_invalid'); }
    if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)
      || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') {
      throw new Error('named_session_proxy_scope_invalid');
    }
    environment[key] = value;
  }
  return environment;
}
