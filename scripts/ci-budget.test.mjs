import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const validate = workflow.jobs.validate;

test('only Windows receives a bounded allowance for measured cold-install and validation time', () => {
  assert.equal(validate['timeout-minutes'], "${{ matrix.os == 'windows-latest' && 25 || 20 }}");
  const coldInstallSeconds = 426;
  const successfulValidationSeconds = 764;
  const setupAuditCleanupSeconds = 43;
  const estimatedSeconds = coldInstallSeconds + successfulValidationSeconds + setupAuditCleanupSeconds;
  assert.ok(estimatedSeconds > 20 * 60);
  assert.ok(estimatedSeconds * 1.2 < 25 * 60);
});

test('all operating systems and required security, packaging and container checks remain', () => {
  assert.deepEqual(validate.strategy.matrix.os, ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.equal(validate.strategy['fail-fast'], false);
  for (const command of [
    'npm ci', 'npm run public:content:check', 'npm run check',
    'node --test scripts/ci-budget.test.mjs', 'npm audit --omit=dev --audit-level=high',
    'docker build --file apps/relay-gateway/Dockerfile --tag dharma-agent-fabric-relay:ci .',
  ]) {
    const step = validate.steps.find(item => item.run === command);
    assert.ok(step, `missing required command: ${command}`);
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.if, command.startsWith('docker ') ? "runner.os == 'Linux'" : undefined);
  }
  const sbom = validate.steps.find(item => item.name === 'Generate CycloneDX SBOM');
  assert.equal(sbom.if, "runner.os == 'Linux'");
  assert.match(sbom.run, /npm sbom --workspaces --include-workspace-root --sbom-format cyclonedx/);
  assert.match(sbom.run, /bom\.bomFormat !== 'CycloneDX'/);
  assert.equal(sbom['continue-on-error'], undefined);
});

test('runtime, dependency identity, event policy and concurrency are unchanged', () => {
  const runtime = validate.steps.find(item => item.name === 'Use Node.js 22');
  assert.equal(runtime.with['node-version'], '22.22.0');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on.push.branches, ['main', 'codex/**']);
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});
