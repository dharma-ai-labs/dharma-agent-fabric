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

const removedSpeculativeTools = [
  'create_evaluation',
  'cancel_task',
  'send_agent_message',
  'propose_remediation',
  'estimate_cost',
];

// Names the hosted server no longer registers. They must not reappear in the
// catalog, the submission or its test cases.
const removedLegacyTools = [
  'fabric_rollout_skill',
  'fabric_advance_remediation',
  'fabric_control_agent_decide_tool',
];

const root = resolve(import.meta.dirname, '..');
const appDir = resolve(root, 'plugins/dharma-agent-fabric/openai-app');
const catalog = JSON.parse(await readFile(resolve(appDir, 'mcp-tool-catalog.json'), 'utf8'));
const snapshot = JSON.parse(await readFile(resolve(appDir, catalog.snapshot), 'utf8'));
const submission = JSON.parse(await readFile(resolve(appDir, 'chatgpt-app-submission.json'), 'utf8'));
const actualTools = catalog.tools.map((tool) => tool.name);
const snapshotTools = new Map(snapshot.tools.map((tool) => [tool.name, tool]));
const submissionHints = (annotations) => ({
  readOnlyHint: annotations.readOnlyHint,
  openWorldHint: annotations.openWorldHint,
  destructiveHint: annotations.destructiveHint,
});

assert.equal(snapshot.schema, 'dharma.mcp-live-tool-snapshot/v1');
assert.equal(snapshot.toolCount, snapshot.tools.length);
assert.equal(catalog.toolCount, catalog.tools.length);
assert.deepEqual(actualTools, snapshot.tools.map((tool) => tool.name), 'public MCP catalog must match the live tool snapshot order');
assert.deepEqual(Object.keys(submission.tools), actualTools, 'OpenAI submission tool declarations must match the public catalog');
assert.deepEqual(catalog.oauthScopes, ['openid', 'user:org:read']);
assert.equal(catalog.resource, 'https://mcp.dharma-ai.io/mcp');
assert.equal(snapshot.resource, catalog.resource);

for (const tool of catalog.tools) {
  const live = snapshotTools.get(tool.name);
  assert.equal(tool.title, live.title, `${tool.name} title drifted from the live snapshot`);
  assert.equal(tool.confirmation, live.confirmation, `${tool.name} confirmation policy drifted`);
  assert.equal(tool.outputSchema, live.outputSchema, `${tool.name} output schema flag drifted`);
  assert.deepEqual(tool.annotations, live.annotations, `${tool.name} annotations drifted from the live snapshot`);
  assert.equal(tool.confirmation, live.inputRequired.includes('confirmed'), `${tool.name} confirmation must match its required input`);
  assert.match(tool.backendScope, /^(membership|fabric:devices|agents:(read|run)|evals:(read|run)|traces:read|skills:(read|write)|usage:read)$/);
  assert.match(tool.mode, /^(read|sensitive_read|write|paid_write|destructive_write)$/);
  assert.equal(typeof tool.adminOnly, 'boolean');
  assert.equal(typeof tool.chatgptProfile, 'boolean');
  assert.equal(tool.mode === 'read' || tool.mode === 'sensitive_read', tool.annotations.readOnlyHint, `${tool.name} mode contradicts readOnlyHint`);
  assert.deepEqual(submission.tools[tool.name]?.annotations, submissionHints(tool.annotations), `${tool.name} submission annotations drifted`);
}

for (const name of [...removedSpeculativeTools, ...removedLegacyTools, ...catalog.forbiddenTools]) {
  assert.equal(actualTools.includes(name), false, `MCP tool ${name} must not be published`);
}

assert.ok(catalog.forbiddenTools.includes('run_arbitrary_shell'));
assert.ok(catalog.forbiddenTools.includes('retrieve_secret'));
const confirmationCount = catalog.tools.filter((tool) => tool.confirmation).length;

if (snapshotManifestPath === null) {
  process.stdout.write(`${JSON.stringify({ ok: true, toolCount: actualTools.length, confirmationCount })}\n`);
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
  let receipt;
  try {
    receipt = compareSnapshotManifest(manifest, referenceFromCatalog(catalog));
  } catch {
    process.stderr.write('snapshot_comparison_unavailable\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.verdict === 'compatible' ? 0 : 1;
}
