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
const readme = readText('README.md');
const checklist = readText('PUBLICATION_CHECKLIST.md');
const dataAndSecurity = readText('DATA_AND_SECURITY.md');
const catalogByName = new Map(catalog.tools.map(tool => [tool.name, tool]));
const snapshotByName = new Map(snapshot.tools.map(tool => [tool.name, tool]));
const LEGACY = ['fabric_rollout_skill', 'fabric_advance_remediation', 'fabric_control_agent_decide_tool'];
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
// AGENTS.md security default: no direct merge or deployment authority. Signed
// skill release, rollout and remediation release tools count as deployment.
const MERGE_OR_DEPLOY = /merge|release|rollout|rollback|expand/;
const testCaseById = id => submission.test_cases.find(testCase => testCase.description.startsWith(`${id}. `));
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
  for (const name of Object.keys(submission.tools)) assert.ok(snapshotByName.has(name), `${name} is not served`);
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

test('the submission declares exactly the ChatGPT profile, with no merge or deployment tool', () => {
  const profile = catalog.tools.filter(tool => tool.chatgptProfile).map(tool => tool.name);
  assert.deepEqual(Object.keys(submission.tools), profile, 'submission must declare the ChatGPT profile, in catalog order');
  assert.deepEqual(profile.filter(name => MERGE_OR_DEPLOY.test(name)), [], 'ChatGPT profile must not contain merge, release or rollout tools');
  assert.match(readme, /\[NICK-DECIDES: [^\]]*server-side filter[^\]]*AGENTS\.md[^\]]*\]/s,
    'README.md must keep the owner decision between a server-side ChatGPT filter and an AGENTS.md amendment');
});

test('test cases are single turn: they name the organization and give any confirmation in the prompt', () => {
  for (const testCase of submission.test_cases) {
    const id = testCase.description.split('.')[0];
    assert.doesNotMatch(testCase.user_prompt, /After I confirm/, `${id} must not depend on a second user turn`);
    assert.doesNotMatch(testCase.expected_output, /Asks for confirmation/, `${id} must not expect a confirmation question`);
    for (const name of toolsOf(testCase)) {
      const live = snapshotByName.get(name);
      assert.equal(live.annotations.readOnlyHint, true, `${id} uses write tool ${name}; ChatGPT adds its own approval step, so it is a guided check`);
      if (live.inputRequired.includes('organizationId')) {
        assert.match(testCase.user_prompt, /\{\{REVIEWER_ORG_ID\}\}/, `${id} must name the reviewer organization`);
      }
      if (live.confirmation) {
        assert.match(testCase.user_prompt, /^I confirm /, `${id} must give the explicit confirmation in the prompt`);
        assert.match(testCase.expected_output, /confirmed true/, `${id} must expect confirmed true`);
      } else {
        assert.doesNotMatch(testCase.user_prompt, /^I confirm/, `${id} is a plain read`);
      }
      assert.ok(testCase.expected_output.includes(`Calls ${name}`) || testCase.expected_output.includes(`calls ${name}`),
        `${id} expected output must name the call to ${name}`);
    }
  }
});

test('the agent listing case tolerates the seeded organization control agent', () => {
  const listing = testCaseById('TC-2');
  assert.ok(listing, 'TC-2 must exist');
  assert.match(listing.expected_output, /exactly two agents/);
  assert.match(listing.expected_output, /dharma:organization-control-agent/);
  assert.match(seedPlan, /runtime activation/i, 'seed plan must require the runtime activation entitlement');
  assert.match(seedPlan, /control agent[^\n]*`ready`/i, 'seed plan must provision the control agent before freezing');
  assert.doesNotMatch(guide, /Results do not depend on order\./, 'order independence is shown by the seed, not asserted');
});

test('the seed plan enrolls without a forbidden step and checks the trajectory count before freezing', () => {
  const commands = seedPlan.split('\n').filter(line => /^\s*dharma (repositories connect|workspace sync) /.test(line));
  assert.ok(commands.length > 0, 'seed plan must name its enrollment command');
  for (const line of commands) assert.match(line, /--policy-revision /, `enrollment command needs --policy-revision: ${line.trim()}`);
  assert.doesNotMatch(seedPlan, /\| Not present \| No GitHub App installation/, 'a connect step needs a GitHub App; do not forbid it and use it');
  const countCheck = seedPlan.indexOf('Trajectory count check');
  const freeze = seedPlan.indexOf('Freeze the seed');
  assert.ok(countCheck > 0 && freeze > countCheck, 'the trajectory count check must come before the seed is frozen');
});

test('the seed plan enrolls only through a CLI path that succeeds with the repository bind it always makes', () => {
  // `dharma workspace sync` always registers the workspace and then requests the
  // repository-agent bind, which the server refuses when the repository-agent
  // model is off. So it is not a route that avoids the repository-agent model.
  const cli = readFileSync(resolve(import.meta.dirname, '..', 'packages/cli/src/index.ts'), 'utf8');
  const workspaceSyncBody = cli.slice(cli.indexOf('async function workspaceSync('), cli.indexOf('async function syncWorkspacePolicy('));
  const workspaceSyncBinds = /registerWorkspaceBeforeRepositoryBind\(/.test(workspaceSyncBody)
    && /bindRepositoryAgent\(fabric, canonical\)/.test(cli);
  if (workspaceSyncBinds) {
    assert.doesNotMatch(seedPlan, /^\s*dharma workspace sync /m, 'workspace sync always binds the repository agent');
    assert.doesNotMatch(seedPlan, /Route A/, 'no seed route may rely on the repository-agent model being off');
  }
  const commands = seedPlan.split('\n').filter(line => /^\s*dharma (repositories connect|workspace (sync|add)) /.test(line));
  assert.ok(commands.length > 0, 'seed plan must name its enrollment command');
  for (const line of commands) assert.match(line, /^\s*dharma repositories connect /, `only repositories connect enrolls: ${line.trim()}`);
  // The readiness readback happens before anything is registered, because a
  // refused bind leaves a registered workspace behind.
  const readiness = seedPlan.indexOf('Readiness check');
  const enroll = seedPlan.search(/^\s*dharma repositories connect /m);
  assert.ok(readiness > 0 && readiness < enroll, 'the readiness check must come before the connect command');
  for (const step of ['`github_app`', '`repository`', '`repository_agent`']) {
    assert.ok(seedPlan.includes(step), `the readiness check must require onboarding step ${step}`);
  }
  // Connect syncs up to 20 existing Codex sessions of the workspace as its first
  // learning evidence, which would add trajectories before T1.
  assert.match(seedPlan, /dharma evidence preview --workspace <demo-repo-path> --provider codex/);
  assert.match(seedPlan, /`trajectoryCount` 0/);
});

test('the checklist gates on the privacy fix and the security summary names every outside recipient', () => {
  assert.doesNotMatch(checklist, /^- \[x\] Privacy policy/m, 'privacy policy item stays open until the privacy fix is published');
  assert.doesNotMatch(checklist, /^- \[x\] Data retention/m, 'retention item stays open until the privacy fix is published');
  assert.match(checklist, /^- \[ \] .*R-OAI-1/m);
  assert.doesNotMatch(dataAndSecurity, /both are limited to organization admins/);
  assert.doesNotMatch(dataAndSecurity, /Full local evidence remains in the encrypted local\s+vault unless/);
  for (const term of ['customer_authorized_content', 'native_provider_payload', 'Google Cloud', 'GitHub', 'Clerk', '[NICK-DECIDES:']) {
    assert.ok(dataAndSecurity.includes(term), `DATA_AND_SECURITY.md must cover ${term}`);
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
