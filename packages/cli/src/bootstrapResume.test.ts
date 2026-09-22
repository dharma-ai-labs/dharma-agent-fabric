import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBootstrapResumeAuthority } from './index.js';

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
