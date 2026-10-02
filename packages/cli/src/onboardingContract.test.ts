import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../AGENT_FABRIC_ONBOARDING.md', import.meta.url);

test('the installed onboarding contract forbids product-code workarounds', async () => {
  const contract = await readFile(contractUrl, 'utf8');

  assert.match(contract, /Do not modify Dharma or customer product code/i);
  assert.match(contract, /Do not create a workaround pull request/i);
  assert.match(contract, /Do not invent credentials/i);
  assert.match(contract, /do not bypass enrollment/i);
  assert.match(contract, /exact failed stage, non-sensitive error, and correlation ID/i);
  assert.match(contract, /supported retry, reconciliation, rollback, or browser-authorized re-enrollment/i);
  assert.match(contract, /retry the unchanged command once before expiry when the receipt explicitly proves non-redemption/i);
  assert.match(contract, /After redemption, approval or another error, use only the supported cause-specific grant-free recovery; never replay the grant/i);
});

test('the installed contract separates agent instructions from recipient-only private terminal entry', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /short-lived grant is a separate recipient-only private field, not part of the agent prompt/i);
  assert.match(contract, /exact generated grant-free `--grant-prompt` command directly in their own private, unrecorded interactive terminal/i);
  assert.match(contract, /Never receive, print, save, commit, place in argv or environment, send through agent tools or transport, or record that grant/i);
  assert.match(contract, /cannot detect an external recorder or prove the human owns a TTY/i);
  assert.match(contract, /no supplementary manual setup command/i);
  assert.match(contract, /Join existing[\s\S]*No GitHub permission or source checkout is needed/i);
  assert.match(contract, /legacy Demo command contract does not establish `--grant-prompt` support/i);
  assert.doesNotMatch(contract, /only routine human action|setup envelope contains[\s\S]*one-time grant/i);
});

test('the installed guide names the supported knowledge and peer workflow', async () => {
  const contract = await readFile(contractUrl, 'utf8');

  assert.match(contract, /repositories snapshot --workspace \. --organization-id <organization-id> --workspace-id <workspace-id> --dry-run/);
  assert.match(contract, /repositories role-discover --workspace-id <workspace-id> --category <category>/);
  assert.match(contract, /repositories ask --workspace-id <workspace-id> --target-endpoint-id <endpoint-id> --category <category> --question/);
  assert.match(contract, /repositories reply --workspace-id <workspace-id> --question-id <question-id>/);
  assert.match(contract, /reads the response rather than manually sending one/);
  assert.match(contract, /active signed release and its source references/);
  assert.match(contract, /detached task worktree is not the enrolled workspace/);
  assert.match(contract, /Do not run `dharma skills verify --workspace \.` there/);
  assert.match(contract, /report the exact denied operation/);
  assert.match(contract, /source edit, successful upload, or local snapshot alone is not publication/);
  assert.doesNotMatch(contract, /dhab_[A-Za-z0-9_-]+/);
});
