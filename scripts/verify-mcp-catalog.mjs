import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compareSnapshotManifest, referenceFromCatalog } from './mcp-catalog-drift.mjs';

// No arguments: unchanged static catalog verification. Opt-in offline mode:
// --snapshot-manifest <file.json> compares explicitly supplied snapshots.
const args = process.argv.slice(2);
let snapshotManifestPath = null;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== '--snapshot-manifest' || !/\.json$/i.test(args[1])) {
    process.stderr.write('Usage: verify-mcp-catalog.mjs [--snapshot-manifest <manifest.json>]\n');
    process.exit(2);
  }
  snapshotManifestPath = resolve(args[1]);
}

const expectedTools = [
  'fabric_get_identity',
  'fabric_list_devices',
  'fabric_list_agents',
  'fabric_list_repository_agents',
  'fabric_get_instructions',
  'fabric_create_agent',
  'fabric_bind_local_endpoint',
  'fabric_bind_runtime_endpoint',
  'fabric_list_workspaces',
  'fabric_list_trajectories',
  'fabric_get_trajectory_evidence',
  'fabric_request_trajectory_evidence',
  'fabric_list_failure_atlas',
  'fabric_list_remediations',
  'fabric_advance_remediation',
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
  'fabric_control_agent_list_sessions',
  'fabric_control_agent_create_session',
  'fabric_control_agent_send_message',
  'fabric_control_agent_list_events',
  'fabric_control_agent_decide_tool',
];

const confirmationTools = new Set([
  'fabric_get_trajectory_evidence',
  'fabric_create_agent',
  'fabric_bind_local_endpoint',
  'fabric_bind_runtime_endpoint',
  'fabric_request_trajectory_evidence',
  'fabric_dispatch_task',
  'fabric_dispatch_a2a',
  'fabric_run_analysis',
  'fabric_release_skill',
  'fabric_rollout_skill',
  'fabric_advance_remediation',
  'fabric_control_agent_create_session',
  'fabric_control_agent_send_message',
  'fabric_control_agent_decide_tool',
]);

const removedSpeculativeTools = [
  'create_evaluation',
  'cancel_task',
  'send_agent_message',
  'propose_remediation',
  'estimate_cost',
];

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, 'plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json');
const catalog = JSON.parse(await readFile(path, 'utf8'));
const submission = JSON.parse(await readFile(
  resolve(root, 'plugins/dharma-agent-fabric/openai-app/chatgpt-app-submission.json'),
  'utf8',
));
const actualTools = catalog.tools.map((tool) => tool.name);

assert.deepEqual(actualTools, expectedTools, 'public MCP catalog must match the HQ registration order');
assert.deepEqual(Object.keys(submission.tools), expectedTools, 'OpenAI submission tool declarations must match the public catalog');
assert.deepEqual(catalog.oauthScopes, ['openid', 'user:org:read']);
assert.equal(catalog.resource, 'https://mcp.dharma-ai.io/mcp');

for (const tool of catalog.tools) {
  assert.equal(tool.confirmation, confirmationTools.has(tool.name), `${tool.name} confirmation policy drifted`);
  assert.match(tool.backendScope, /^(fabric:devices|agents:(read|run)|evals:(read|run)|traces:read|skills:(read|write)|usage:read)$/);
  assert.deepEqual(submission.tools[tool.name]?.annotations, tool.annotations, `${tool.name} submission annotations drifted`);
}

for (const name of removedSpeculativeTools) {
  assert.equal(actualTools.includes(name), false, `speculative MCP tool ${name} must not be published`);
}

assert.ok(catalog.forbiddenTools.includes('run_arbitrary_shell'));
assert.ok(catalog.forbiddenTools.includes('retrieve_secret'));

if (snapshotManifestPath === null) {
  process.stdout.write(`${JSON.stringify({ ok: true, toolCount: actualTools.length, confirmationCount: confirmationTools.size })}\n`);
} else {
  let manifest;
  try {
    const info = await stat(snapshotManifestPath);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('size');
    manifest = JSON.parse(await readFile(snapshotManifestPath, 'utf8'));
  } catch {
    process.stderr.write('snapshot_manifest_unreadable\n');
    process.exit(2);
  }
  const receipt = compareSnapshotManifest(manifest, referenceFromCatalog(catalog));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.verdict === 'compatible' ? 0 : 1;
}
