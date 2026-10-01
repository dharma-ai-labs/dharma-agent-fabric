import { mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertRepositoryInstallerOwnership, checkedPath, writeRepositoryInstallerFile } from './repositoryInstallerFiles.js';

export type RepositoryJoinConnection = {
  workspace: string;
  workspaceId: string;
  organizationId: string;
  bindingId: string;
  sourceFingerprint: string;
  repositoryAgentId: string;
  repositoryAgentKey: string;
  controlBranch: string;
  hqUrl: string;
  policyRevision: string;
  onboardingMarkdown: string;
};

// Join state is local metadata, never a source inventory or a signed release.
export async function installRepositoryJoinConnection(input: RepositoryJoinConnection) {
  const ownership = await assertRepositoryInstallerOwnership(input.workspace, input.workspaceId);
  const workspace = await realpath(input.workspace);
  await checkedPath(workspace, resolve(workspace, '.dharma/join-identity.json'), 'file');
  const marker = JSON.parse(await readFile(resolve(workspace, '.dharma/join-identity.json'), 'utf8'));
  if (!marker || Object.keys(marker).sort().join(',') !== 'bindingId,organizationId,sourceFingerprint'
    || marker.organizationId !== input.organizationId || marker.bindingId !== input.bindingId
    || marker.sourceFingerprint !== input.sourceFingerprint) {
    throw new Error('repository_join_workspace_identity_conflict');
  }
  const existing = await readFile(resolve(workspace, '.dharma/agent-fabric.json'), 'utf8')
    .then(value => JSON.parse(value) as Record<string, unknown>)
    .catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
  if (existing && (existing.schema !== 'dharma.repository-connection/v2'
    || existing.organizationId !== input.organizationId || existing.workspaceId !== input.workspaceId
    || existing.repositoryAgentId !== input.repositoryAgentId || existing.repositoryBindingId !== input.bindingId
    || existing.hqUrl !== input.hqUrl || existing.accessMode !== 'knowledge_only')) {
    throw new Error('repository_join_connection_scope_conflict');
  }
  if (ownership !== 'signed') {
    await mkdir(resolve(workspace, '.agents/skills/dharma-agent-fabric/references'), { recursive: true, mode: 0o700 });
    await writeRepositoryInstallerFile(workspace, '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
      `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId })}\n`);
    await writeRepositoryInstallerFile(workspace, '.agents/skills/dharma-agent-fabric/SKILL.md',
      `---\nname: dharma-agent-fabric\ndescription: Shared repository knowledge and bounded team coordination.\n---\n\n${input.onboardingMarkdown}`);
    await writeRepositoryInstallerFile(workspace, '.agents/skills/dharma-agent-fabric/references/organization.md',
      `# Joined repository\n\nOrganization: ${input.organizationId}\nWorkspace: ${input.workspaceId}\nRepository binding: ${input.bindingId}\nAccess: knowledge-only\n`);
  }
  const connection = {
    schema: 'dharma.repository-connection/v2', hqUrl: input.hqUrl,
    organizationId: input.organizationId, workspaceId: input.workspaceId,
    repositoryAgentId: input.repositoryAgentId, repositoryBindingId: input.bindingId,
    repositoryAgentKey: input.repositoryAgentKey, controlBranch: input.controlBranch,
    policyRevision: input.policyRevision, accessMode: 'knowledge_only',
    openapiUrl: `${input.hqUrl}/api/v1/agent-fabric/openapi.json`,
    instructionsUrl: `${input.hqUrl}/api/v1/orgs/${input.organizationId}/agent-fabric/instructions`,
  };
  await writeRepositoryInstallerFile(workspace, '.dharma/agent-fabric.json', `${JSON.stringify(connection, null, 2)}\n`);
  await writeRepositoryInstallerFile(workspace, '.dharma/repository-agent.json', `${JSON.stringify({
    schema: 'dharma.repository-agent/v1', organizationId: input.organizationId,
    organizationAgentId: input.repositoryAgentId, agentKey: input.repositoryAgentKey,
    controlBranch: input.controlBranch, workspaceId: input.workspaceId,
  }, null, 2)}\n`);
  return { connectionPath: '.dharma/agent-fabric.json', accessMode: 'knowledge_only' as const };
}
