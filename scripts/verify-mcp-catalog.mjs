import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const expectedTools = [
  'fabric_list_devices',
  'fabric_list_agents',
  'fabric_list_workspaces',
  'fabric_list_trajectories',
  'fabric_get_trajectory_evidence',
  'fabric_list_failure_atlas',
  'fabric_list_tasks',
  'fabric_list_a2a',
  'fabric_list_skills',
  'fabric_list_evals',
  'fabric_list_usage',
  'fabric_dispatch_task',
  'fabric_dispatch_a2a',
  'fabric_run_analysis',
  'fabric_release_skill',
  'fabric_rollout_skill',
];

const confirmationTools = new Set([
  'fabric_get_trajectory_evidence',
  'fabric_dispatch_task',
  'fabric_dispatch_a2a',
  'fabric_run_analysis',
  'fabric_release_skill',
  'fabric_rollout_skill',
]);

const removedSpeculativeTools = [
  'request_additional_evidence',
  'create_evaluation',
  'cancel_task',
  'send_agent_message',
  'propose_remediation',
  'estimate_cost',
];

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, 'plugin/openai-app/mcp-tool-catalog.json');
const catalog = JSON.parse(await readFile(path, 'utf8'));
const actualTools = catalog.tools.map((tool) => tool.name);

assert.deepEqual(actualTools, expectedTools, 'public MCP catalog must match the HQ registration order');
assert.deepEqual(catalog.oauthScopes, ['openid', 'user:org:read']);
assert.equal(catalog.resource, 'https://mcp.dharma-ai.io/mcp');

for (const tool of catalog.tools) {
  assert.equal(tool.confirmation, confirmationTools.has(tool.name), `${tool.name} confirmation policy drifted`);
  assert.match(tool.backendScope, /^(fabric:devices|agents:(read|run)|evals:(read|run)|traces:read|skills:(read|write)|usage:read)$/);
}

for (const name of removedSpeculativeTools) {
  assert.equal(actualTools.includes(name), false, `speculative MCP tool ${name} must not be published`);
}

assert.ok(catalog.forbiddenTools.includes('run_arbitrary_shell'));
assert.ok(catalog.forbiddenTools.includes('retrieve_secret'));

process.stdout.write(`${JSON.stringify({ ok: true, toolCount: actualTools.length, confirmationCount: confirmationTools.size })}\n`);
