import { lstat, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SANDBOX_FIX, type RegisteredCommandSandbox, type SandboxRefusalReason } from '@dharma-ai-labs/agent-fabric-task-runner';

// `dharma relay sandbox status [--json]`: the operator's read-only view of the relay's command
// sandbox. It runs the same live probe the relay runs before every task that names registered
// commands, once, and prints the answer. It takes no option but --json and changes nothing: the
// probe's scratch folder is removed by the probe, and any folder this command had to create for
// it (on a host without a Dharma home yet) is removed here. A usable answer exits 0; a refusal
// exits 1 with the typed reason. It neither admits a task nor writes a receipt.

export const RELAY_SANDBOX_STATUS_SCHEMA = 'dharma.relay-sandbox-status/v1';
const USABLE_HEADLINE = 'Command sandbox: usable';

/** The refusal reasons a host probe gives. `network_not_denied` belongs to one task, not to the host. */
export const HOST_SANDBOX_REFUSAL_REASONS = Object.freeze(['platform_unsupported', 'bubblewrap_missing', 'bubblewrap_too_old',
  'bubblewrap_untrusted', 'user_namespaces_unavailable', 'sandbox_probe_failed'] as const satisfies readonly SandboxRefusalReason[]);
export type HostSandboxRefusalReason = (typeof HOST_SANDBOX_REFUSAL_REASONS)[number];

function isHostSandboxRefusalReason(reason: SandboxRefusalReason): reason is HostSandboxRefusalReason {
  return (HOST_SANDBOX_REFUSAL_REASONS as readonly SandboxRefusalReason[]).includes(reason);
}

export type RelaySandboxStatus =
  | {
    schema: typeof RELAY_SANDBOX_STATUS_SCHEMA;
    usable: true;
    host: 'linux' | 'wsl2';
    bwrapPath: string;
    bwrapVersion: string;
    bwrapSha256: string;
    policy: string;
    probe: { result: 'passed'; checks: string[]; probedAt: string };
  }
  | { schema: typeof RELAY_SANDBOX_STATUS_SCHEMA; usable: false; reason: HostSandboxRefusalReason; detail: string; fix: string };

/** Refuses every option but a bare --json, and any argument after `status`, before the probe runs. */
export function assertRelaySandboxStatusOptions(positional: string[], flags: Map<string, string | boolean>,
  repeated: Map<string, Array<string | boolean>>): void {
  if (positional.length !== 3 || [...flags.keys()].some(key => key !== 'json') || (flags.has('json') && flags.get('json') !== true)
    || [...repeated.values()].some(values => values.length !== 1)) {
    throw new Error('relay_sandbox_status_options_invalid: use dharma relay sandbox status [--json]; it takes no other option.');
  }
}

/**
 * The printed status for one probe answer. Pure. The usable form carries the fields a task receipt
 * records for its sandbox; the Node installation paths, which can sit under the user's home, are not
 * printed. A refusal carries a host reason only: a task-only reason from the probe is printed as
 * `sandbox_probe_failed`, with that reason in the detail.
 */
export function relaySandboxStatus(sandbox: RegisteredCommandSandbox): RelaySandboxStatus {
  if (!sandbox.usable) {
    if (isHostSandboxRefusalReason(sandbox.reason)) {
      return { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: false, reason: sandbox.reason, detail: sandbox.detail, fix: sandbox.fix };
    }
    return { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: false, reason: 'sandbox_probe_failed',
      detail: `The probe gave the task-only reason ${sandbox.reason}: ${sandbox.detail}`, fix: SANDBOX_FIX.sandbox_probe_failed };
  }
  return { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: true, host: sandbox.host, bwrapPath: sandbox.bwrapPath,
    bwrapVersion: sandbox.bwrapVersion, bwrapSha256: sandbox.bwrapSha256, policy: sandbox.policy,
    probe: { result: 'passed', checks: [...sandbox.probe.checks], probedAt: sandbox.probe.probedAt } };
}

/** The folders from `path` upward that do not exist yet, deepest first. */
async function missingFolders(path: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    const absent = await lstat(current).then(() => false, (error: NodeJS.ErrnoException) => error?.code === 'ENOENT');
    if (!absent) break;
    missing.push(current);
    if (dirname(current) === current) break;
  }
  return missing;
}

/**
 * Runs the relay's sandbox probe once on `relayStateDirectory`, the directory the relay probes in,
 * and returns the printed status. Folders that did not exist before are removed afterwards when
 * they are empty; a folder something else wrote to in the meantime is kept.
 */
export async function readRelaySandboxStatus(input: { relayStateDirectory: string;
  probe: (options: { relayStateDirectory: string }) => Promise<RegisteredCommandSandbox> }): Promise<RelaySandboxStatus> {
  const created = await missingFolders(resolve(input.relayStateDirectory, 'sandbox-probe'));
  try {
    return relaySandboxStatus(await input.probe({ relayStateDirectory: input.relayStateDirectory }));
  } finally {
    for (const folder of created) await rmdir(folder).catch(() => undefined);
  }
}

/** The readable form, printed without --json. Its first line says usable or the refusal reason. */
export function formatRelaySandboxStatus(status: RelaySandboxStatus): string {
  if (!status.usable) {
    return [`Command sandbox: refused (${status.reason})`, `Detail: ${status.detail}`, `Fix: ${status.fix}`,
      'Tasks that name registered commands are refused on this host.'].join('\n');
  }
  return [USABLE_HEADLINE, `Host: ${status.host}`, `bubblewrap: ${status.bwrapPath} ${status.bwrapVersion} (${status.bwrapSha256})`,
    `Policy: ${status.policy}`, `Probe: passed ${status.probe.checks.length} checks at ${status.probe.probedAt}`,
    'Tasks that name registered commands and have network authority deny can run on this host; the relay probes again before each one.'].join('\n');
}

/** 0 for a usable status, in either form; 1 for a refusal or anything else. */
export function relaySandboxStatusExitCode(value: unknown): number {
  if (typeof value === 'string') return value.startsWith(`${USABLE_HEADLINE}\n`) ? 0 : 1;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 1;
  const status = value as Record<string, unknown>;
  return status.schema === RELAY_SANDBOX_STATUS_SCHEMA && status.usable === true ? 0 : 1;
}
