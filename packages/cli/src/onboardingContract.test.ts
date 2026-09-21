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
