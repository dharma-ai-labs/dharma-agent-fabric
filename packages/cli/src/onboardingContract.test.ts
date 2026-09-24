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
});

test('the installed guide names the supported knowledge and peer workflow', async () => {
  const contract = await readFile(contractUrl, 'utf8');

  assert.match(contract, /repositories snapshot --workspace \. --organization-id <organization-id> --workspace-id <workspace-id> --dry-run/);
  assert.match(contract, /repositories role-discover --workspace-id <workspace-id> --category <category>/);
  assert.match(contract, /repositories ask --workspace-id <workspace-id> --target-endpoint-id <endpoint-id> --category <category> --question/);
  assert.match(contract, /repositories reply --workspace-id <workspace-id> --question-id <question-id>/);
  assert.match(contract, /reads the response rather than manually sending one/);
  assert.match(contract, /active signed release and its source references/);
  assert.match(contract, /source edit, successful upload, or local snapshot alone is not publication/);
  assert.doesNotMatch(contract, /dhab_[A-Za-z0-9_-]+/);
});
