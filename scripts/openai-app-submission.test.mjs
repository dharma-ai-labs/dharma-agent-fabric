// Offline checks for the ChatGPT app submission package: the catalog matches
// the checked-in live tool snapshot, and every reviewer test case names only
// live tools, carries the inputs the server requires, and is documented in the
// reviewer guide and seed plan. No network, server process or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const appDir = resolve(import.meta.dirname, '..', 'plugins/dharma-agent-fabric/openai-app');
const readJson = name => JSON.parse(readFileSync(resolve(appDir, name), 'utf8'));
const readText = name => readFileSync(resolve(appDir, name), 'utf8');
const catalog = readJson('mcp-tool-catalog.json');
const snapshot = readJson(catalog.snapshot);
const submission = readJson('chatgpt-app-submission.json');
const guide = readText('REVIEWER_GUIDE.md');
const seedPlan = readText('REVIEWER_SEED_PLAN.md');
const catalogByName = new Map(catalog.tools.map(tool => [tool.name, tool]));
const snapshotByName = new Map(snapshot.tools.map(tool => [tool.name, tool]));
const LEGACY = ['fabric_rollout_skill', 'fabric_advance_remediation', 'fabric_control_agent_decide_tool'];
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
const toolsOf = testCase => String(testCase.tools_triggered).split(',').map(name => name.trim()).filter(Boolean);

test('catalog matches the checked-in live tool snapshot exactly', () => {
  assert.equal(snapshot.schema, 'dharma.mcp-live-tool-snapshot/v1');
  assert.equal(snapshot.resource, catalog.resource);
  assert.deepEqual(catalog.tools.map(tool => tool.name), snapshot.tools.map(tool => tool.name));
  assert.equal(new Set(snapshot.tools.map(tool => tool.name)).size, snapshot.tools.length, 'duplicate live tool');
  for (const tool of catalog.tools) {
    const live = snapshotByName.get(tool.name);
    assert.equal(tool.title, live.title, tool.name);
    assert.deepEqual(tool.annotations, live.annotations, tool.name);
    assert.equal(tool.confirmation, live.confirmation, tool.name);
  }
  assert.deepEqual(Object.keys(submission.tools), snapshot.tools.map(tool => tool.name));
  for (const name of LEGACY) assert.equal(snapshotByName.has(name), false, `${name} is not served`);
});

test('every test case names only live catalog tools in the proposed ChatGPT profile', () => {
  assert.ok(submission.test_cases.length >= 5);
  submission.test_cases.forEach((testCase, index) => {
    assert.ok(testCase.description.startsWith(`TC-${index + 1}. `), `test case ${index + 1} must be numbered TC-${index + 1}`);
    const tools = toolsOf(testCase);
    assert.ok(tools.length > 0, `TC-${index + 1} must name its tool`);
    for (const name of tools) {
      assert.ok(catalogByName.has(name), `TC-${index + 1} references ${name}, which the hosted server does not expose`);
      assert.equal(catalogByName.get(name).chatgptProfile, true, `TC-${index + 1} tool ${name} is outside the ChatGPT profile`);
      assert.equal(LEGACY.includes(name), false);
    }
  });
});

test('test cases name the organization and the explicit confirmation each tool requires', () => {
  for (const testCase of submission.test_cases) {
    const id = testCase.description.split('.')[0];
    for (const name of toolsOf(testCase)) {
      const live = snapshotByName.get(name);
      if (live.inputRequired.includes('organizationId')) {
        assert.match(testCase.user_prompt, /\{\{REVIEWER_ORG_ID\}\}/, `${id} must name the reviewer organization`);
      }
      if (live.confirmation) {
        assert.match(testCase.user_prompt, /^After I confirm, /, `${id} must ask for explicit confirmation`);
        assert.match(testCase.expected_output, /^Asks for confirmation before the call, /, `${id} must expect a confirmation step`);
      } else {
        assert.doesNotMatch(testCase.user_prompt, /After I confirm/, `${id} is a plain read`);
      }
      assert.ok(testCase.expected_output.includes(`Calls ${name}`) || testCase.expected_output.includes(`calls ${name}`),
        `${id} expected output must name the call to ${name}`);
    }
  }
});

test('every placeholder is defined by the seed plan and every test case is documented in the reviewer guide', () => {
  const used = new Set();
  for (const testCase of submission.test_cases) {
    for (const field of [testCase.user_prompt, testCase.expected_output]) {
      for (const match of field.matchAll(PLACEHOLDER)) used.add(match[1]);
    }
    const id = testCase.description.split('.')[0];
    assert.ok(guide.includes(`### ${id} `), `REVIEWER_GUIDE.md must document ${id}`);
  }
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(seedPlan.includes(`\`{{${name}}}\``), `REVIEWER_SEED_PLAN.md must define {{${name}}}`);
  }
  for (const testCase of submission.negative_test_cases) {
    assert.doesNotMatch(testCase.user_prompt, PLACEHOLDER);
  }
});

test('the three negative cases call no tool and no live tool offers what they ask for', () => {
  assert.equal(submission.negative_test_cases.length, 3);
  for (const testCase of submission.negative_test_cases) {
    assert.equal(testCase.tools_triggered, null, testCase.description);
    assert.match(testCase.expected_output, /^No Dharma Agent Fabric tool is called\./, testCase.description);
  }
  const names = catalog.tools.map(tool => tool.name);
  for (const pattern of [/calendar|meeting/, /shell|exec_command|run_command/, /secret|credential|private_key|upload|read_file|home_dir/]) {
    assert.deepEqual(names.filter(name => pattern.test(name)), [], `no live tool may match ${pattern}`);
  }
  for (const name of catalog.forbiddenTools) assert.equal(names.includes(name), false, name);
});
