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

// The real-sandbox proof also runs on Ubuntu 22.04. Its bubblewrap (0.6) is older than 0.8.0, so
// the sandbox runs there without --disable-userns and the probe skips the nested-namespace check:
// a different argument list from ubuntu-latest that must be proved on a real host. The job builds
// once and runs only the sandbox steps: the same preparation, the real-sandbox file with `usable`,
// the operator's `relay sandbox status` on the usable and on the restricted host, and the same
// refusal proof. Removing the job or weakening a step turns this test red.
test('an Ubuntu 22.04 job proves the real sandbox, the operator status command and the refusal', () => {
  const job = workflow.jobs['sandbox-ubuntu-2204'];
  assert.ok(job, 'missing job: sandbox-ubuntu-2204');
  assert.equal(job.name, 'Command sandbox (ubuntu-22.04)');
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job.strategy, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job['timeout-minutes'], 15);
  const names = ['Check out source', 'Use Node.js 22', 'Install locked dependencies', 'Build packages',
    'Prepare command sandbox', 'Use the distribution Git', 'Run real-sandbox tests', 'Check the operator sandbox status',
    'Prove sandbox refusal on a restricted host'];
  assert.deepEqual(job.steps.map(item => item.name), names);
  const step = name => job.steps.find(item => item.name === name);
  const validateStep = name => validate.steps.find(item => item.name === name);
  for (const item of job.steps) {
    assert.equal(item['continue-on-error'], undefined, `${item.name} may not continue on error`);
    assert.equal(item.if, undefined, `${item.name} always runs`);
  }
  // The runner image adds a newer Git from a PPA; stock Ubuntu 22.04 has Git 2.34. The sandbox
  // steps run with the distribution's Git, so the job proves what a stock host does with a
  // task-written .gitattributes: Git older than 2.41 fails the task closed.
  const distroGit = step('Use the distribution Git');
  assert.equal(distroGit.shell, 'bash');
  for (const line of [
    `distro=$(apt-cache madison git | awk -F'|' '$3 !~ /launchpadcontent/ { gsub(/ /, "", $2); print $2; exit }')`,
    'test -n "$distro"',
    'sudo apt-get install -y --no-install-recommends --allow-downgrades "git=$distro" "git-man=$distro"',
    "git --version | grep -E '^git version 2\\.34\\.'",
  ]) assert.ok(distroGit.run.split('\n').includes(line), `Use the distribution Git runs: ${line}`);
  assert.doesNotMatch(distroGit.run, /\|\|\s*true/);
  const names2 = job.steps.map(item => item.name);
  assert.ok(names2.indexOf('Use the distribution Git') > names2.indexOf('Build packages'), 'the build keeps the image Git');
  // The same pinned actions and runtime as the validation legs.
  assert.deepEqual(step('Check out source'), validateStep('Check out source'));
  assert.deepEqual(step('Use Node.js 22'), validateStep('Use Node.js 22'));
  assert.equal(step('Install locked dependencies').run, 'npm ci');
  assert.equal(step('Build packages').run, 'npm run build');
  // The same preparation as ubuntu-latest: default user-namespace settings, reported only.
  const prepare = step('Prepare command sandbox');
  assert.equal(prepare.shell, 'bash');
  assert.equal(prepare.run, validateStep('Prepare command sandbox').run);
  assert.doesNotMatch(prepare.run, /sysctl/, 'the usable proof does not relax host settings');
  const real = step('Run real-sandbox tests');
  assert.deepEqual(real.env, { DHARMA_SANDBOX_EXPECT: 'usable' });
  assert.equal(real.run, 'node --test packages/task-runner/dist/registeredCommandSandbox.linux.test.js');
  // The operator command must say usable, exit 0 and leave no Dharma home behind.
  const status = step('Check the operator sandbox status');
  assert.equal(status.shell, 'bash');
  assert.match(status.run, /DHARMA_HOME="\$home" node packages\/cli\/dist\/bin\.js relay sandbox status --json > "\$RUNNER_TEMP\/sandbox-usable\.json"\n/);
  assert.match(status.run, /s\.usable !== true/);
  assert.match(status.run, /test ! -e "\$home"/);
  assert.doesNotMatch(status.run, /\|\|\s*true/);
  // The same refusal proof as ubuntu-latest, and the operator command must refuse with the reason.
  const refusal = step('Prove sandbox refusal on a restricted host');
  assert.equal(refusal.shell, 'bash');
  assert.match(refusal.run, /sysctl -w user\.max_user_namespaces=0\n/);
  assert.match(refusal.run, /DHARMA_SANDBOX_EXPECT=refused node --test packages\/task-runner\/dist\/registeredCommandSandbox\.linux\.test\.js\n/);
  assert.match(refusal.run, /node packages\/cli\/dist\/bin\.js relay sandbox status --json > "\$RUNNER_TEMP\/sandbox-refused\.json" \|\| code=\$\?\n/);
  assert.match(refusal.run, /test "\$code" = 1\n/);
  assert.match(refusal.run, /s\.reason !== 'user_namespaces_unavailable'/);
  assert.match(refusal.run, /test ! -e "\$home"/);
  assert.match(refusal.run, /sysctl -w user\.max_user_namespaces="\$original"\s*$/);
  assert.doesNotMatch(refusal.run, /\|\|\s*true/);
});

// Stock Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1 and has no AppArmor
// profile for bubblewrap, so the sandbox is refused there. The runner images do not show that
// (ubuntu-latest ships a profile for bubblewrap), so this job turns the restriction on itself,
// proves the typed refusal, installs the documented profile from the one file the documentation
// prints, and proves the sandbox usable with the full real-sandbox file. Removing the job or
// weakening a step turns this test red.
test('an Ubuntu 24.04 job proves the refusal under the AppArmor restriction and the documented profile', () => {
  const job = workflow.jobs['sandbox-ubuntu-2404-restricted'];
  assert.ok(job, 'missing job: sandbox-ubuntu-2404-restricted');
  assert.equal(job.name, 'Command sandbox (ubuntu-24.04 restricted)');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.strategy, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job['timeout-minutes'], 15);
  const names = ['Check out source', 'Use Node.js 22', 'Install locked dependencies', 'Build packages',
    'Prepare command sandbox', 'Restrict user namespaces through AppArmor', 'Prove the restricted host refuses',
    'Install the documented AppArmor profile', 'Check the operator sandbox status', 'Run real-sandbox tests'];
  assert.deepEqual(job.steps.map(item => item.name), names);
  const step = name => job.steps.find(item => item.name === name);
  const validateStep = name => validate.steps.find(item => item.name === name);
  for (const item of job.steps) {
    assert.equal(item['continue-on-error'], undefined, `${item.name} may not continue on error`);
    assert.equal(item.if, undefined, `${item.name} always runs`);
    if (item.run) assert.doesNotMatch(item.run, /\|\|\s*true/, `${item.name} may not swallow a failure`);
  }
  assert.deepEqual(step('Check out source'), validateStep('Check out source'));
  assert.deepEqual(step('Use Node.js 22'), validateStep('Use Node.js 22'));
  assert.equal(step('Install locked dependencies').run, 'npm ci');
  assert.equal(step('Build packages').run, 'npm run build');
  assert.equal(step('Prepare command sandbox').run, validateStep('Prepare command sandbox').run);
  const restrict = step('Restrict user namespaces through AppArmor');
  assert.equal(restrict.shell, 'bash');
  assert.match(restrict.run, /^sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=1\n/);
  assert.match(restrict.run, /test "\$\(cat \/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns\)" = 1/);
  // The operator command refuses with the typed reason, the AppArmor setting and the profile fix.
  const refusal = step('Prove the restricted host refuses');
  assert.equal(refusal.shell, 'bash');
  assert.match(refusal.run, /DHARMA_HOME="\$home" node packages\/cli\/dist\/bin\.js relay sandbox status --json > "\$RUNNER_TEMP\/sandbox-restricted\.json" \|\| code=\$\?\n/);
  assert.match(refusal.run, /test "\$code" = 1\n/);
  assert.match(refusal.run, /s\.reason !== 'user_namespaces_unavailable'/);
  assert.match(refusal.run, /!s\.detail\.includes\('apparmor_restrict_unprivileged_userns=1'\)/);
  assert.match(refusal.run, /!s\.fix\.includes\('\/etc\/apparmor\.d\/bwrap-dharma'\)/);
  assert.match(refusal.run, /test ! -e "\$home"/);
  // The profile goes in exactly as the documentation says; the restriction stays on.
  const install = step('Install the documented AppArmor profile');
  assert.equal(install.shell, 'bash');
  assert.match(install.run, /^sudo install -o root -g root -m 0644 packaging\/apparmor\/bwrap-dharma \/etc\/apparmor\.d\/bwrap-dharma\n/);
  assert.match(install.run, /\nsudo apparmor_parser -r \/etc\/apparmor\.d\/bwrap-dharma\n/);
  assert.match(install.run, /test "\$\(cat \/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns\)" = 1/);
  const status = step('Check the operator sandbox status');
  assert.equal(status.shell, 'bash');
  assert.match(status.run, /DHARMA_HOME="\$home" node packages\/cli\/dist\/bin\.js relay sandbox status --json > "\$RUNNER_TEMP\/sandbox-usable\.json"\n/);
  assert.match(status.run, /s\.usable !== true/);
  assert.match(status.run, /test ! -e "\$home"/);
  const real = step('Run real-sandbox tests');
  assert.deepEqual(real.env, { DHARMA_SANDBOX_EXPECT: 'usable' });
  assert.equal(real.run, 'node --test packages/task-runner/dist/registeredCommandSandbox.linux.test.js');
  assert.ok(job.steps.every(item => !/apparmor_restrict_unprivileged_userns=0/.test(item.run ?? '')),
    'the job never lifts the restriction');
});

// The documentation and CI share one profile file. The customer guide and the task-runner README
// print it verbatim with the same install and load commands that CI runs, say not to lift the
// restriction for the whole system, and list Git 2.41 or later.
test('the documented AppArmor profile is the file CI installs, and the host requirements list Git 2.41', () => {
  const profile = readFileSync(new URL('../packaging/apparmor/bwrap-dharma', import.meta.url), 'utf8');
  assert.match(profile, /^abi <abi\/4\.0>,\ninclude <tunables\/global>\n\nprofile bwrap-dharma \/usr\/bin\/bwrap flags=\(unconfined\) \{\n {2}userns,\n\}\n$/m);
  assert.ok(profile.endsWith('profile bwrap-dharma /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n'), 'the profile grants userns only');
  const install = workflow.jobs['sandbox-ubuntu-2404-restricted'].steps
    .find(item => item.name === 'Install the documented AppArmor profile').run;
  const commands = ['sudo install -o root -g root -m 0644 bwrap-dharma /etc/apparmor.d/bwrap-dharma',
    'sudo apparmor_parser -r /etc/apparmor.d/bwrap-dharma'];
  assert.ok(install.includes(commands[0].replace(' bwrap-dharma ', ' packaging/apparmor/bwrap-dharma ')), 'CI installs the repository file');
  assert.ok(install.includes(commands[1]), 'CI loads the profile as documented');
  for (const path of ['../docs/onboarding/customer-guide.md', '../packages/task-runner/README.md']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.ok(text.includes(profile.trimEnd()), `${path} prints packaging/apparmor/bwrap-dharma verbatim`);
    assert.ok(text.includes('packaging/apparmor/bwrap-dharma'), `${path} names the profile file`);
    for (const command of commands) assert.ok(text.includes(command), `${path} documents: ${command}`);
    assert.match(text, /Do not set\s+`kernel\.apparmor_restrict_unprivileged_userns=0`/, `${path} warns against the system-wide setting`);
    assert.match(text, /Git 2\.41 or\s+later/, `${path} lists Git 2.41 or later`);
  }
  const guide = readFileSync(new URL('../docs/onboarding/customer-guide.md', import.meta.url), 'utf8');
  const requirements = guide.slice(guide.indexOf('## Host requirements for registered commands'));
  assert.match(requirements.slice(0, requirements.indexOf('macOS and native Windows')), /Git 2\.41 or\s+later/,
    'Git 2.41 or later is in the host requirement list');
});
