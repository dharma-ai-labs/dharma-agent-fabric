// Pins the ChatGPT app package to the tool profile the hosted server serves to
// ChatGPT clients. A ChatGPT connection sees only these 20 tools and is refused
// every other one, so the catalog profile, the submission declarations and each
// reviewer test case must stay inside it. No network, server or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const appDir = resolve(import.meta.dirname, '..', 'plugins/dharma-agent-fabric/openai-app');
const readJson = name => JSON.parse(readFileSync(resolve(appDir, name), 'utf8'));
const catalog = readJson('mcp-tool-catalog.json');
const submission = readJson('chatgpt-app-submission.json');

// Copy of CHATGPT_MCP_TOOL_PROFILE in dharma-ai-platform
// src/lib/agent-fabric/chatgptToolProfile.ts (main 6acdd2b3), in its order.
// Change both together.
const SERVED_CHATGPT_PROFILE = [
  'fabric_get_identity',
  'fabric_list_devices',
  'fabric_list_agents',
  'fabric_list_repository_agents',
  'fabric_get_instructions',
  'fabric_list_workspaces',
  'fabric_list_trajectories',
  'fabric_get_trajectory_evidence',
  'fabric_list_failure_atlas',
  'fabric_list_remediations',
  'fabric_list_tasks',
  'fabric_list_a2a',
  'fabric_list_skills',
  'fabric_list_evals',
  'fabric_list_usage',
  'fabric_dispatch_task',
  'fabric_control_agent_list_sessions',
  'fabric_control_agent_create_session',
  'fabric_control_agent_send_message',
  'fabric_control_agent_list_events',
];

// The hosted server no longer registers these names.
const REMOVED = ['fabric_advance_remediation', 'fabric_rollout_skill', 'fabric_control_agent_decide_tool'];

const toolsOf = testCase => String(testCase.tools_triggered ?? '').split(',').map(name => name.trim()).filter(Boolean);

test('the catalog lists no removed tool', () => {
  const names = catalog.tools.map(tool => tool.name);
  for (const name of REMOVED) assert.equal(names.includes(name), false, `catalog still lists removed tool ${name}`);
});

test('the catalog ChatGPT profile is exactly the profile the server serves to ChatGPT', () => {
  const profile = catalog.tools.filter(tool => tool.chatgptProfile === true).map(tool => tool.name);
  assert.deepEqual(profile, SERVED_CHATGPT_PROFILE);
});

test('the submission declares exactly the served ChatGPT profile', () => {
  assert.deepEqual(Object.keys(submission.tools), SERVED_CHATGPT_PROFILE);
});

test('every reviewer test case calls only tools inside the served ChatGPT profile', () => {
  assert.ok(submission.test_cases.length > 0);
  for (const testCase of submission.test_cases) {
    const tools = toolsOf(testCase);
    assert.ok(tools.length > 0, `${testCase.description} names no tool`);
    for (const name of tools) {
      assert.ok(SERVED_CHATGPT_PROFILE.includes(name), `${testCase.description} calls ${name}, which ChatGPT is refused`);
    }
  }
  for (const testCase of submission.negative_test_cases) {
    assert.deepEqual(toolsOf(testCase), [], `${testCase.description} must call no tool`);
  }
});
