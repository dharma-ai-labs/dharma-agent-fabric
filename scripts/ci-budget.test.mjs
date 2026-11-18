import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const validate = workflow.jobs.validate;

test('only Windows receives a bounded allowance for measured cold-install and validation time', () => {
  assert.equal(validate['timeout-minutes'], "${{ matrix.os == 'windows-latest' && 35 || 20 }}");
  // Slowest passing windows-latest job in 25 CI runs on 2026-11-28: 24m49s (install, validation,
  // setup, audit and cleanup). Four attempts that day were cancelled at the 25-minute limit.
  const observedWindowsSeconds = 24 * 60 + 49;
  assert.ok(observedWindowsSeconds > 20 * 60);
  assert.ok(observedWindowsSeconds * 1.2 < 35 * 60);
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

// Registered commands run inside an operating-system sandbox. The Linux leg must prove
// it with the real bubblewrap, and must also prove the refusal on a restricted host. Removing or
// weakening either proof turns this test red.
test('the Linux leg prepares the command sandbox, requires it to be usable and proves the refusal', () => {
  const names = validate.steps.map(item => item.name);
  const prepare = validate.steps.find(item => item.name === 'Prepare command sandbox');
  const validation = validate.steps.find(item => item.run === 'npm run check');
  const refusal = validate.steps.find(item => item.name === 'Prove sandbox refusal on a restricted host');
  assert.ok(prepare, 'missing step: Prepare command sandbox');
  assert.ok(refusal, 'missing step: Prove sandbox refusal on a restricted host');
  assert.ok(names.indexOf(prepare.name) < names.indexOf(validation.name), 'the sandbox is prepared before validation');
  assert.ok(names.indexOf(refusal.name) > names.indexOf(validation.name), 'the refusal proof runs after validation');
  for (const step of [prepare, refusal]) {
    assert.equal(step.if, "runner.os == 'Linux'");
    assert.equal(step.shell, 'bash');
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.match(prepare.run, /apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(prepare.run, /\/usr\/bin\/bwrap --version/);
  // The usable proof runs on the image's default user-namespace settings; it only reports them.
  assert.match(prepare.run, /apparmor_restrict_unprivileged_userns=\$\(cat /);
  assert.doesNotMatch(prepare.run, /sysctl/, 'the usable proof does not relax host settings');
  assert.equal(validation.env?.DHARMA_SANDBOX_EXPECT, "${{ runner.os == 'Linux' && 'usable' || '' }}");
  assert.equal(validation['continue-on-error'], undefined);
  assert.match(refusal.run, /sysctl -w user\.max_user_namespaces=0\n/);
  assert.match(refusal.run, /DHARMA_SANDBOX_EXPECT=refused node --test packages\/task-runner\/dist\/registeredCommandSandbox\.linux\.test\.js/);
  assert.match(refusal.run, /sysctl -w user\.max_user_namespaces="\$original"\s*$/);
  assert.doesNotMatch(refusal.run, /\|\|\s*true/);
});
