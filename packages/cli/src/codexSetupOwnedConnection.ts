import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {openCodexAppServerTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {verifyCodexSetupReadOnlyProfile} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import {namedCodexEnvironment} from './namedCodexEnvironment.js';
import {namedCodexFilesystem} from './namedCodexFilesystem.js';

/** Internal controller connection, not a model-selected command or transport. */
export async function openCodexSetupOwnedConnection(input: {
  workspace: string; deviceHome: string; expectedAccountEmail: string;
  signal: AbortSignal; current(): Promise<boolean>;
}) {
  if (process.platform !== 'linux' || !input.expectedAccountEmail
    || input.expectedAccountEmail.length > 254 || /[\s\u0000-\u001f\u007f]/.test(input.expectedAccountEmail)) {
    throw new Error('codex_setup_owned_route_unqualified');
  }
  const assert = async () => {
    if (input.signal.aborted || !await input.current() || input.signal.aborted) {
      throw new Error('codex_setup_host_scope_unavailable');
    }
  };
  await assert();
  const environment = namedCodexEnvironment(process.env);
  const privateRoots = [input.deviceHome, resolve(environment.CODEX_HOME || resolve(homedir(), '.codex'))];
  if (environment.XDG_RUNTIME_DIR) privateRoots.push(environment.XDG_RUNTIME_DIR);
  if (environment.DBUS_SESSION_BUS_ADDRESS) privateRoots.push(environment.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length));
  const filesystem = await namedCodexFilesystem({environment, workspace: input.workspace, privateRoots, writeRoots: []});
  await assert();
  const transport = await openCodexAppServerTransport({command: 'codex', cwd: input.workspace,
    environment, experimentalApi: true, toolCallTimeoutMs: 60_000, setupApprovalTimeoutMs: 900_000,
    argv: ['-c', 'apps._default.enabled=false', '-c', 'default_permissions="dharma_bridge"',
      '-c', `permissions.dharma_bridge.filesystem=${filesystem.peer}`,
      '-c', 'permissions.dharma_bridge.network={enabled=false}', 'app-server']});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= transport.close();
  const abort = () => {void close().catch(() => {});};
  input.signal.addEventListener('abort', abort, {once: true});
  const current = async () => {
    if (input.signal.aborted || transport.signal.aborted || !await input.current()) return false;
    const result = await transport.request('account/read', {refreshToken: false}) as {
      account?: {type?: unknown; email?: unknown};
    };
    return !input.signal.aborted && !transport.signal.aborted
      && result?.account?.type === 'chatgpt' && result.account.email === input.expectedAccountEmail
      && await input.current() && !input.signal.aborted && !transport.signal.aborted;
  };
  try {
    await assert();
    if (!await current()) throw new Error('codex_setup_owned_account_unconfirmed');
    await verifyCodexSetupReadOnlyProfile(transport, input.workspace,
      {async step(operation) {await assert(); const result = await operation(); await assert(); return result;}},
      filesystem.additionalFilesystemRules);
    await assert();
    return Object.freeze({transport, additionalFilesystemRules: filesystem.additionalFilesystemRules, current,
      close: async () => {input.signal.removeEventListener('abort', abort); await close();}});
  } catch {
    input.signal.removeEventListener('abort', abort);
    try {await close();} catch {throw new Error('codex_setup_owned_close_unconfirmed');}
    throw new Error('codex_setup_owned_connection_unqualified');
  }
}
