import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBootstrapResumeAuthority, commandExitCode } from './index.js';

const organizationId = 'org_test';
const hqUrl = 'https://www.dharma-ai.io';
const existing = { organizationId, hqUrl };

function flags(...entries: Array<[string, string | boolean]>) {
  return new Map<string, string | boolean>([['resume', true], ['complete', true], ...entries]);
}

test('a completed bootstrap may resume with its existing organization-bound device and no grant', () => {
  assert.doesNotThrow(() => assertBootstrapResumeAuthority({ flags: flags(), existing, organizationId, hqUrl }));
});

test('resume cannot redeem another grant or replace enrollment', () => {
  for (const [name, value] of [['grant', 'dhab_not_redeemed'], ['replace-existing-enrollment', true]] as const) {
    assert.throws(() => assertBootstrapResumeAuthority({
      flags: flags([name, value]), existing, organizationId, hqUrl,
    }), /cannot accept a grant or replace an enrollment/);
  }
  assert.throws(() => assertBootstrapResumeAuthority({
    flags: new Map([['resume', true]]), existing, organizationId, hqUrl,
  }), /requires --complete/);
});

test('resume rejects absent, foreign-organization, and foreign-origin device identities', () => {
  for (const device of [null, { ...existing, organizationId: 'org_other' },
    { ...existing, hqUrl: 'https://other.example' }]) {
    assert.throws(() => assertBootstrapResumeAuthority({
      flags: flags(), existing: device, organizationId, hqUrl,
    }), /existing device enrolled to this organization and portal/);
  }
});

test('complete bootstrap exits unsuccessfully unless the shared package is ready', () => {
  const command = ['bootstrap', '--resume', '--complete'];
  assert.equal(commandExitCode(command, { ok: false, stage: 'shared_repository_blocked' }), 1);
  assert.equal(commandExitCode(command, { ok: true, stage: 'shared_repository_pending', sharedRepositoryReady: false }), 1);
  assert.equal(commandExitCode(command, { ok: true, stage: 'complete', sharedRepositoryReady: false }), 1);
  assert.equal(commandExitCode(command, { ok: true, stage: 'complete', sharedRepositoryReady: true }), 0);
});

test('partial bootstrap and other commands retain their existing exit contract', () => {
  assert.equal(commandExitCode(['bootstrap'], { ok: false, stage: 'organization_api_credentials' }), 1);
  assert.equal(commandExitCode(['bootstrap'], { ok: true, stage: 'shared_repository_pending' }), 0);
  assert.equal(commandExitCode(['bootstrap', '--help'], 'Usage'), 0);
  assert.equal(commandExitCode(['repositories', 'status'], { ok: false }), 0);
});
