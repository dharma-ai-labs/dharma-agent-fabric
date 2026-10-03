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
  assert.match(contract, /same owned process/i);
  assert.match(contract, /never replay an expired or spent setup/i);
});

test('the installed contract uses one agent-run public reference and exact recipient browser approval', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /public setup reference is not a bearer credential/i);
  assert.match(contract, /actual authenticated coding-agent conversation/i);
  assert.match(contract, /agent runs the exact generated `--setup-reference` command/i);
  assert.match(contract, /credentials move only from the trusted HTTPS endpoint into the native protected store/i);
  assert.match(contract, /never request a human terminal command, grant paste or keyring troubleshooting/i);
  assert.match(contract, /no supplementary manual setup command/i);
  assert.match(contract, /Join existing[\s\S]*No GitHub permission or source checkout is needed/i);
  assert.match(contract, /legacy Demo command contract does not establish setup-reference support/i);
  assert.doesNotMatch(contract, /recipient runs.*`--grant-prompt`|personally runs.*`--grant-prompt`|private terminal grant entry/i);
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
