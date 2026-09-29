import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertRepositoryInstallerOwnership, checkedPath, writeRepositoryInstallerFile } from './repositoryInstallerFiles.js';
import { selectDeviceWorkspace, type OnboardingWorkspaceRecord } from './onboardingWorkspace.js';

export function selectLegacyInstallerRecoveryWorkspace<T extends OnboardingWorkspaceRecord & { routeHash: string }>(
  records: readonly T[], input: { organizationId: string; deviceId: string; path: string;
    repositoryRemoteHash: string; workspaceId: string },
): T {
  const current = selectDeviceWorkspace(records, input);
  const canonical = records.filter(record => record.workspaceId === input.workspaceId);
  if (!current || canonical.length !== 1 || canonical[0]!.organizationId !== input.organizationId
    || canonical[0]!.path !== input.path || canonical[0]!.repositoryRemoteHash !== input.repositoryRemoteHash
    || canonical[0]!.routeHash !== current.routeHash) {
    throw new Error('Recovery requires the enrolled device canonical repository binding.');
  }
  // Caller must verify current signed policy and live source consent for this
  // exact workspace. Registry aliases alone never authorize replacement.
  return canonical[0]!;
}

const execute = promisify(execFile);
async function gitRead(workspace: string, args: string[]) {
  try {
    return (await execute('git', ['-C', workspace, ...args],
      { encoding: 'buffer', timeout: 10_000, maxBuffer: 256_000 })).stdout;
  } catch {
    throw new Error('Legacy installer is not unchanged tracked Git content.');
  }
}
const root = '.agents/skills/dharma-agent-fabric';
const markerPath = `${root}/.dharma-agent-fabric.json`;
const files = [markerPath, `${root}/SKILL.md`, `${root}/references/organization.md`,
  '.dharma/agent-fabric.json', '.dharma/repository-agent.json'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Called only after current enrollment, signed workspace policy and repository
// source consent have been verified. It never migrates a signed bundle or trust.
export async function recoverLegacyRepositoryInstaller(input: {
  workspace: string; fromWorkspaceId: string; workspaceId: string; repositoryAgentKey: string; apply: boolean;
}) {
  if (!uuid.test(input.fromWorkspaceId) || !uuid.test(input.workspaceId)
    || input.fromWorkspaceId === input.workspaceId || !/^repo:[0-9a-f]{24}$/.test(input.repositoryAgentKey)) {
    throw new Error('Legacy installer recovery identity is invalid.');
  }
  const workspace = await realpath(input.workspace);
  const ownership = await assertRepositoryInstallerOwnership(workspace, input.fromWorkspaceId);
  if (ownership !== 'installer') throw new Error('Legacy recovery requires an unsigned installer marker.');
  const entries = await readdir(resolve(workspace, root), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(entry.parentPath, entry.name);
    if (entry.isDirectory() && path === resolve(workspace, root, 'references')) continue;
    if (!entry.isFile() || !files.some(file => resolve(workspace, file) === path)) {
      throw new Error('Legacy installer contains extra or unsupported files.');
    }
  }
  const originals = new Map<string, Buffer>();
  await gitRead(workspace, ['diff', '--cached', '--quiet', 'HEAD', '--', ...files]);
  for (const path of files) {
    if (!await checkedPath(workspace, resolve(workspace, path), 'file')) {
      throw new Error('Legacy installer file is missing.');
    }
    const current = await readFile(resolve(workspace, path));
    if (current.length > 256_000) throw new Error('Legacy installer file exceeds recovery limit.');
    const committed = await gitRead(workspace, ['show', `HEAD:${path}`]);
    // Git text checkout conversion may produce CRLF on Windows. No other
    // normalization, filter, staged edit or locally modified content is accepted.
    if (!current.equals(committed) && !current.equals(Buffer.from(committed.toString('utf8').replace(/\r?\n/g, '\r\n')))) {
      throw new Error('Legacy installer has modified or untracked content.');
    }
    originals.set(path, current);
  }
  const connection = JSON.parse(originals.get('.dharma/agent-fabric.json')!.toString('utf8'));
  const agent = JSON.parse(originals.get('.dharma/repository-agent.json')!.toString('utf8'));
  if (connection.schema !== 'dharma.repository-connection/v2' || agent.schema !== 'dharma.repository-agent/v1'
    || connection.workspaceId !== input.fromWorkspaceId || agent.workspaceId !== input.fromWorkspaceId
    || connection.organizationId !== agent.organizationId || typeof agent.organizationId !== 'string'
    || connection.repositoryAgentKey !== input.repositoryAgentKey || agent.agentKey !== input.repositoryAgentKey) {
    throw new Error('Legacy installer repository identity mismatch.');
  }
  const receipt = { schema: 'dharma.legacy-installer-recovery/v1', applied: false,
    fromWorkspaceId: input.fromWorkspaceId, workspaceId: input.workspaceId,
    repositoryAgentKey: input.repositoryAgentKey, signedLifecycleReady: false as const,
    backupDirectory: null as string | null,
    files: [...originals].map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })) };
  if (!input.apply) return receipt;
  const backupDirectory = `.dharma/installer-recovery/${randomUUID()}`;
  await checkedPath(workspace, resolve(workspace, '.dharma', 'installer-recovery'), 'directory');
  await mkdir(resolve(workspace, backupDirectory), { recursive: true, mode: 0o700 });
  for (const [path, content] of originals) {
    const target = resolve(workspace, backupDirectory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  }
  // Recheck every source immediately before the only replacement. A partial
  // backup cannot change ownership; preserved originals remain recoverable.
  await assertRepositoryInstallerOwnership(workspace, input.fromWorkspaceId);
  for (const [path, content] of originals) {
    await checkedPath(workspace, resolve(workspace, path), 'file');
    if (!(await readFile(resolve(workspace, path))).equals(content)) throw new Error('Legacy installer changed during recovery.');
  }
  await writeRepositoryInstallerFile(workspace, markerPath, `${JSON.stringify({
    managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId,
  }, null, 2)}\n`, originals.get(markerPath));
  return { ...receipt, applied: true, backupDirectory };
}
