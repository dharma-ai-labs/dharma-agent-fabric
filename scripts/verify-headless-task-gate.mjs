// Release check for WINDOWS_HEADLESS_TASK_SINCE in packages/cli/src/relayAutostart.ts.
//
// The gate names the first CLI release whose ownership guards accept the headless
// actions of the Windows task and the WSL host task. A rollback to an earlier release
// registers the PowerShell actions that release owns instead. Releases are cut from a
// release branch by picking changes, so the release that first ships the guard is
// known only at release time. If the gate names a release that shipped without the
// guard, a rollback to that release registers an action it reports as a conflict.
//
// Release tags (v<major>.<minor>.<patch>) carry the CLI version. The gate must equal
// the first tagged release that carries the guard. Before any release carries it, the
// gate must be above every release, and a release in progress (a CLI version above
// every tag) must set the gate to its own version.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const gateSource = 'packages/cli/src/relayAutostart.ts';
const gatePattern = /const WINDOWS_HEADLESS_TASK_SINCE = \[(\d+), (\d+), (\d+)\];/;

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : null;
}

// The gate a source text defines, or null when it carries no headless guard.
export function readGate(sourceText) {
  const match = gatePattern.exec(sourceText);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const show = (version) => version.join('.');

// gateAt(release) returns the gate that release defines, or null without the guard.
// The walk goes down from the newest release and stops at the first one without the
// guard, so only releases made since the guard landed are read.
export function headlessTaskGateErrors({ gate, version, releases, gateAt }) {
  if (!gate) return [`${gateSource} must define WINDOWS_HEADLESS_TASK_SINCE as [major, minor, patch].`];
  if (releases.length === 0) return ['No release tags found. Fetch the repository tags before this check.'];
  const newestFirst = [...releases].sort((left, right) => compareVersions(right, left));
  let first = null;
  for (const release of newestFirst) {
    if (!gateAt(release)) break;
    first = release;
  }
  if (first) {
    return compareVersions(gate, first) === 0 ? [] : [
      `WINDOWS_HEADLESS_TASK_SINCE is ${show(gate)}, but ${show(first)} is the first release that carries the headless guard. Set it to ${show(first)}.`,
    ];
  }
  const newest = newestFirst[0];
  if (compareVersions(gate, newest) <= 0) {
    return [
      `WINDOWS_HEADLESS_TASK_SINCE is ${show(gate)}, but release ${show(newest)} shipped without the headless guard. Set it to the release that first carries the guard, above ${show(newest)}.`,
    ];
  }
  if (version && compareVersions(version, newest) > 0 && compareVersions(gate, version) !== 0) {
    return [
      `CLI ${show(version)} is the first release that carries the headless guard, but WINDOWS_HEADLESS_TASK_SINCE is ${show(gate)}. Set it to ${show(version)}.`,
    ];
  }
  return [];
}

export function checkRepository(repository) {
  const git = (args) => execFileSync('git', args, {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const releases = git(['tag', '--list', 'v*']).split('\n').map(parseVersion).filter(Boolean);
  const gateAt = (release) => {
    // A release tagged before the source file existed carries no guard.
    try { return readGate(git(['show', `v${show(release)}:${gateSource}`])); } catch { return null; }
  };
  const { version } = JSON.parse(readFileSync(resolve(repository, 'packages/cli/package.json'), 'utf8'));
  return headlessTaskGateErrors({
    gate: readGate(readFileSync(resolve(repository, gateSource), 'utf8')),
    version: parseVersion(version),
    releases,
    gateAt,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkRepository(resolve(import.meta.dirname, '..'));
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  console.log('WINDOWS_HEADLESS_TASK_SINCE matches the release history.');
}
