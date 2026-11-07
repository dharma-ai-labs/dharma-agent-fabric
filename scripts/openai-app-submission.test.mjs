// Offline checks for the ChatGPT app submission package: the catalog matches
// the checked-in live tool snapshot, and every reviewer test case names only
// live tools, carries the inputs the server requires, and is documented in the
// reviewer guide and seed plan. No network, server process or credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
// Owner-decision blocks still open in a document, one string per block.
const openDecisions = text => [...text.matchAll(/\[NICK-DECIDES:([^\]]*)\]/g)].map(match => match[1].replace(/\s+/g, ' '));
// The paragraph (blank-line bounded) that starts with the given text.
const paragraphStarting = (text, start) => text.split(/\n\s*\n/).find(paragraph => paragraph.startsWith(start)) ?? '';
const PRIVACY_POLICY_VERSION = '2026-10-31';
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
  const filterDecision = paragraphStarting(readme, 'Owner decision (Nick, 2026-10-31): ship a server-side filter');
  assert.match(filterDecision, /keyed to the ChatGPT OAuth\s+client/, 'README.md must record the server-side ChatGPT filter decision');
  assert.match(filterDecision, /AGENTS\.md stays unchanged/, 'the same decision paragraph must say AGENTS.md stays unchanged');
  assert.doesNotMatch(readme, /NICK-DECIDES/, 'README.md has no open owner decision left');
  assert.match(checklist, /^- \[ \] The ChatGPT app is not given merge or deployment tools in practice\..*server-side filter/m,
    'the checklist keeps the filter item open until the filter ships');
});

test('the seed plan records the owner decisions on the reviewer role and organization', () => {
  assert.match(seedPlan, /Owner decision \(Nick, 2026-10-31\): the reviewer account is `developer`/);
  assert.match(seedPlan, /Owner decision \(Nick, 2026-10-31\): a dedicated reviewer organization/);
  assert.match(seedPlan, /asks Nick\s+before creating/);
  // Topic-scoped: no open owner-decision block may still ask about the
  // reviewer role or which reviewer organization to use, whatever its wording.
  for (const block of openDecisions(seedPlan)) {
    assert.doesNotMatch(block, /role|developer|viewer/i, `seed plan reopens the decided reviewer role: ${block.trim()}`);
    assert.doesNotMatch(block, /(reuse|existing|dedicated|new|separate|which)\s+(the\s+)?reviewer organi[sz]ation/i,
      `seed plan reopens the decided reviewer organization: ${block.trim()}`);
  }
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

test('the published privacy policy closes its gate, and owner approval and retention proof stay open', () => {
  // https://www.dharma-ai.io/privacy has served policy version 2026-10-31 since 2026-10-31.
  assert.match(checklist, new RegExp(String.raw`^- \[x\] Privacy policy published in its revised form, policy version ${'`'}${PRIVACY_POLICY_VERSION}${'`'}`, 'm'),
    'the published-policy item is checked and names the published policy version');
  assert.doesNotMatch(checklist, /^- \[ \] Privacy policy published/m);
  assert.doesNotMatch(checklist, /that fix is not yet published/);
  // R-OAI-1 needs the owner's approval of DATA_AND_SECURITY.md; the retention
  // item needs a recorded production retention receipt. Neither is recorded.
  assert.match(checklist, /^- \[ \] R-OAI-1/m, 'R-OAI-1 stays open until the owner approves DATA_AND_SECURITY.md');
  assert.match(checklist, /^- \[ \] Data retention/m, 'retention item stays open until a retention receipt is recorded');
  const header = dataAndSecurity.split(/\n## /)[0];
  assert.ok(header.includes(`policy version \`${PRIVACY_POLICY_VERSION}\``), 'DATA_AND_SECURITY.md names the published policy version it follows');
  assert.doesNotMatch(header, /Until that revision is published/, 'the policy is published; the draft gate is the owner approval only');
  assert.ok(openDecisions(header).some(block => /approval of this text/.test(block)), 'the owner approval of this text stays an open decision');
});

test('the checklist gates on the privacy fix and the security summary names every outside recipient', () => {
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

test('the submission-time check fails loudly while any placeholder is unsubstituted', () => {
  // {{REVIEWER_ORG_ID}} stays a placeholder in the repository until the owner
  // provides the reviewer organization. The copy pasted into the OpenAI form
  // must pass this check first.
  const script = resolve(import.meta.dirname, 'openai-app-submission-filled.mjs');
  const committed = spawnSync(process.execPath, [script, resolve(appDir, 'chatgpt-app-submission.json')], { encoding: 'utf8' });
  assert.equal(committed.status, 1, 'the committed package still holds placeholders and must not pass');
  assert.match(committed.stderr, /\{\{REVIEWER_ORG_ID\}\} at test_cases\[0\]\.user_prompt/);
  assert.match(committed.stderr, /^not ready to submit: \d+ unsubstituted placeholder/m);

  const dir = mkdtempSync(join(tmpdir(), 'openai-app-filled-'));
  try {
    const filledPath = join(dir, 'filled.json');
    const filled = JSON.stringify(submission).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => `seed-${name.toLowerCase()}`);
    writeFileSync(filledPath, filled);
    const ok = spawnSync(process.execPath, [script, filledPath], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { ok: true, placeholders: 0 });

    // A half-substituted copy (braces removed, name left) is still refused.
    writeFileSync(filledPath, filled.replace('seed-reviewer_org_id', 'REVIEWER_ORG_ID'));
    const half = spawnSync(process.execPath, [script, filledPath], { encoding: 'utf8' });
    assert.equal(half.status, 1);
    assert.match(half.stderr, /REVIEWER_ORG_ID at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(checklist, /^- \[ \] Placeholders substituted .*`node scripts\/openai-app-submission-filled\.mjs <substituted-copy\.json>` passes/m,
    'the checklist requires the submission-time placeholder check');
});

test('trajectory IDs are recorded per seed build, so a rebuild or a second organization never reuses one', () => {
  // agent_fabric_trajectories.id is a global primary key, so an ID ingested in
  // one organization cannot be ingested again in a rebuilt or copied seed.
  const trajectoryIds = ['T1', 'T2', 'T3', 'T4', 'T5'].map(id => `REVIEWER_${id}_ID`);
  for (const [name, text] of [['chatgpt-app-submission.json', JSON.stringify(submission)], ['REVIEWER_GUIDE.md', guide], ['REVIEWER_SEED_PLAN.md', seedPlan]]) {
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${name} must not hard-code a trajectory UUID`);
  }
  assert.doesNotMatch(seedPlan, /fixed and are not placeholders/);
  for (const name of trajectoryIds) assert.ok(seedPlan.includes(`\`{{${name}}}\``), `REVIEWER_SEED_PLAN.md must define {{${name}}}`);
  const listing = testCaseById('TC-3');
  const order = trajectoryIds.slice().reverse().map(name => listing.expected_output.indexOf(`{{${name}}}`));
  assert.ok(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1])), 'TC-3 must list T5 to T1 newest first by placeholder');
  const evidence = testCaseById('TC-4');
  assert.match(evidence.user_prompt, /\{\{REVIEWER_T1_ID\}\}/);
  assert.match(evidence.expected_output, /trajectoryId \{\{REVIEWER_T1_ID\}\}/);
  assert.match(seedPlan, /new random[^.]*UUID[^.]*every\s+seed\s+build/i, 'each seed build generates new trajectory IDs');
  assert.match(seedPlan, /own\s+(organi[sz]ation|seed\s+build)[^.]*own\s+placeholder\s+values/i, 'a guided-check copy is a separate seed build with its own values');
});

test('every declared write tool has a run-order rule and a reset, and TC-6 does not depend on the reviewer never writing', () => {
  const writeTools = Object.keys(submission.tools).filter(name => snapshotByName.get(name).annotations.readOnlyHint === false);
  assert.ok(writeTools.length > 0);
  const reset = seedPlan.slice(seedPlan.indexOf('## Reset'));
  assert.doesNotMatch(reset, /nothing needs resetting/i);
  assert.doesNotMatch(reset, /\| Nothing\./);
  for (const name of writeTools) {
    assert.ok(reset.includes(`\`${name}\``), `the seed plan reset table must cover write tool ${name}`);
  }
  const runOrder = guide.slice(guide.indexOf('## Run order'));
  assert.ok(guide.includes('## Run order') && guide.indexOf('## Run order') < guide.indexOf('## Submitted test cases'), 'REVIEWER_GUIDE.md states the run order before the cases');
  assert.match(runOrder, /after[^.]*web and[^.]*mobile/i, 'write tools run only after the web and mobile runs');
  assert.doesNotMatch(guide, /you can run them in any order/, 'order does not hold once a write tool has run');
  const sessions = testCaseById('TC-6');
  assert.match(sessions.expected_output, /Seed provisioning/, 'TC-6 shows the operator conversation is never listed');
  assert.match(sessions.expected_output, /only conversations the reviewer account created/);
});

test('the seed is rebuilt before capsule retention can change TC-4', () => {
  const retention = Number(dataAndSecurity.match(/Default capsules become tombstones (\d+) days after upload/)?.[1]);
  assert.ok(retention > 0, 'DATA_AND_SECURITY.md states the default capsule retention');
  const maxAge = Number(seedPlan.match(/younger than (\d+) days/)?.[1]);
  assert.ok(maxAge > 0, 'the seed plan states a maximum seed age');
  assert.ok(maxAge <= retention - 14, `a ${maxAge}-day seed age leaves less than a 14-day review window before the ${retention}-day tombstone`);
  assert.ok(seedPlan.includes(`${retention}-day`), 'the seed plan names the capsule retention it works around');
  assert.match(seedPlan.slice(seedPlan.indexOf('## Reset')), /retention/i, 'the reset table covers the retention tombstone');
});

test('the submitted cases hold whatever order they run in, including after a declared write tool', () => {
  // OpenAI receives the submitted cases, not REVIEWER_GUIDE.md, so a run-order
  // rule in the guide does not protect a case. A control-agent message records
  // a managed trajectory and a reviewer conversation appears in TC-6, so those
  // two cases must tolerate both on their own.
  for (const testCase of submission.test_cases) {
    const id = testCase.description.split('.')[0];
    assert.doesNotMatch(testCase.expected_output, /before any write tool/i, `${id} must not depend on no write having run`);
    assert.doesNotMatch(testCase.expected_output, /list is empty/i, `${id} must not expect an empty list`);
  }
  const listing = testCaseById('TC-3');
  assert.doesNotMatch(listing.user_prompt, /\b5 most recent\b/, 'TC-3 must not ask for only the newest 5 rows');
  assert.doesNotMatch(listing.expected_output, /limit 5\b|exactly 5 trajectories/, 'a newer managed trajectory must not push T1 out of TC-3');
  assert.match(listing.expected_output, /limit 50/, 'TC-3 lists up to 50 rows, so T1 to T5 stay in the list');
  assert.match(listing.expected_output, /whether or not a write tool ran/i, 'TC-3 says in the submitted text that a prior write does not change it');
  const sessions = testCaseById('TC-6');
  assert.match(sessions.expected_output, /whether or not a write tool ran/i, 'TC-6 says in the submitted text that a prior write does not change it');
  const tc3Guide = guide.slice(guide.indexOf('### TC-3 '), guide.indexOf('### TC-4 '));
  assert.doesNotMatch(tc3Guide, /limit` 5|exactly 5 trajectories/, 'REVIEWER_GUIDE.md TC-3 matches the submitted case');
  const tc6Guide = guide.slice(guide.indexOf('### TC-6 '), guide.indexOf('### Negative cases'));
  assert.doesNotMatch(tc6Guide, /list is empty/, 'REVIEWER_GUIDE.md TC-6 matches the submitted case');
  const reset = seedPlan.slice(seedPlan.indexOf('## Reset'));
  assert.doesNotMatch(reset, /Rebuild before the next run of TC-3/, 'a control-agent message no longer breaks TC-3 within a round');
  const acceptance = seedPlan.slice(seedPlan.indexOf('## Acceptance before submission'), seedPlan.indexOf('## Reset'));
  assert.match(acceptance, /guided-check organization[^.]*TC-3 and TC-6/, 'acceptance observes TC-3 and TC-6 after writes, in the guided-check organization');
});

test('the pre-round check sees every conversation, including one the reviewer created', () => {
  // A developer sees only its own conversations, but an org_admin sees all of
  // them, so the operator readback catches a reviewer-created conversation.
  const step7 = seedPlan.slice(seedPlan.indexOf('7. **Control agent.**'), seedPlan.indexOf('8. **Freeze the seed.**'));
  assert.match(step7, /`fabric_control_agent_list_sessions`/, 'step 7 reads back the conversations as the operator');
  assert.match(step7, /exactly one conversation[^.]*`Seed provisioning`/, 'the operator readback holds only the seeding conversation');
  const preRound = paragraphStarting(seedPlan, 'Before every review round');
  assert.match(preRound, /conversation/, 'the pre-round check repeats the conversation readback');
});

test('the seed capsules are default capsules, so the 90-day retention is the shortest that applies', () => {
  // Synchronized content follows an admin retention of 1 to 365 days, which can
  // be shorter than the seed age limit. The seed never turns that policy on.
  assert.match(seedPlan, /\| Content disclosure policy \| Off[^|]*default capsule/, 'the required state keeps content synchronization off');
  const step4 = seedPlan.slice(seedPlan.indexOf('4. **Trajectories.**'), seedPlan.indexOf('5. **Stop the relay.**'));
  assert.match(step4, /content disclosure policy[^.]*off/i, 'both step-4 options run with content synchronization off');
});
