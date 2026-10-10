import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
const publish = workflow.jobs.publish;
const step = publish.steps.find((item) => item.name === 'Publish public workspaces');

test('bounded onboarding publication is explicit and opt-in', () => {
  const input = workflow.on.workflow_dispatch.inputs.onboarding_only;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.equal(publish.if, "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'");
});

test('bounded mode invokes the reviewed exact-package allowlist rather than the broad publisher', () => {
  assert.equal(step.env.ONBOARDING_ONLY, "${{ github.event_name == 'workflow_dispatch' && inputs.onboarding_only || false }}");
  assert.equal(step.env.EXPECTED_HEAD, '${{ inputs.expected_head }}');
  assert.match(step.run, /if \[ "\$ONBOARDING_ONLY" = "true" \]; then\s+npm run publish:onboarding -- --expected-head "\$EXPECTED_HEAD"\s+exit 0\s+fi/);
  assert.match(step.run, /for workspace in "\$\{workspaces\[@\]\}"/);
});

test('bounded manual publication cannot invoke Python publication', () => {
  assert.equal(workflow.jobs['publish-python'].if,
    "vars.PYPI_PUBLISH_ENABLED == 'true' && !(github.event_name == 'workflow_dispatch' && inputs.onboarding_only)");
});

test('manual main publication does not try to publish a main GitHub release tag', () => {
  const release = publish.steps.find((item) => item.name === 'Publish GitHub Release');
  assert.equal(release.if, "startsWith(github.ref, 'refs/tags/')");
  assert.match(release.run, /--verify-tag/);
});

test('existing immutable package handling and publisher credentials stay intact', () => {
  assert.equal(step.env.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
  assert.match(step.run, /preserving immutable release/i);
  assert.match(step.run, /npm publish --workspace/);
  assert.equal(publish.environment, 'npm');
  assert.equal(workflow.permissions['id-token'], 'write');
});
