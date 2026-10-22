import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    "vars.PYPI_PUBLISH_ENABLED == 'true' && !(github.event_name == 'workflow_dispatch' && (inputs.onboarding_only || inputs.contracts_only || inputs.device_maintenance_only || inputs.artifacts_only))");
});

test('maintenance publication is separate, opt-in, main-only and admitted before dependency installation',()=>{
  const input=workflow.on.workflow_dispatch.inputs.device_maintenance_only;
  assert.deepEqual({type:input.type,default:input.default},{type:'boolean',default:false});
  const validation=publish.steps.find(item=>item.name==='Validate publication scope');
  assert.equal(validation.env.DEVICE_MAINTENANCE_ONLY,"${{ github.event_name == 'workflow_dispatch' && inputs.device_maintenance_only || false }}");
  assert.ok(publish.steps.indexOf(validation)<publish.steps.findIndex(item=>item.run==='npm ci'));
  assert.match(validation.run,/node scripts\/publish-device-maintenance.mjs --expected-head "\$EXPECTED_HEAD" --admission-only/);
  for(const selected of [validation,step]){
    assert.match(selected.run,/for selected in "\$ONBOARDING_ONLY" "\$CONTRACTS_ONLY" "\$DEVICE_MAINTENANCE_ONLY"/);
    assert.match(selected.run,/if \[ "\$selected_scopes" -gt 1 \]; then/);
  }
  assert.match(step.run,/npm run publish:device-maintenance -- --expected-head "\$EXPECTED_HEAD" --publish\s+exit 0\s+fi/);
});

test('workflow verifies the independent publisher hash before executing it at both gates',()=>{
  const validation=publish.steps.find(item=>item.name==='Validate publication scope');
  const expected=createHash('sha256').update(readFileSync(new URL('./publish-device-maintenance.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n')).digest('hex');
  for(const item of [validation,step]){
    assert.equal(item.env.MAINTENANCE_PUBLISHER_SHA256,expected);
    assert.match(item.run,/printf '%s  %s\\n' "\$MAINTENANCE_PUBLISHER_SHA256" scripts\/publish-device-maintenance.mjs \| sha256sum --check --status/);
    assert.ok(item.run.indexOf('sha256sum --check --status')<item.run.indexOf(item===validation?'node scripts/publish-device-maintenance.mjs':'npm run publish:device-maintenance'));
  }
});

test('manual main publication does not try to publish a main GitHub release tag', () => {
  const release = publish.steps.find((item) => item.name === 'Publish GitHub Release');
  assert.equal(release.if, "startsWith(github.ref, 'refs/tags/') && !(github.event_name == 'workflow_dispatch' && inputs.artifacts_only)");
  assert.match(release.run, /--verify-tag/);
});

test('existing immutable package handling and publisher credentials stay intact', () => {
  assert.equal(step.env.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
  assert.match(step.run, /preserving immutable release/i);
  assert.match(step.run, /npm publish --workspace/);
  assert.equal(publish.environment, 'npm');
  assert.equal(workflow.permissions['id-token'], 'write');
});
