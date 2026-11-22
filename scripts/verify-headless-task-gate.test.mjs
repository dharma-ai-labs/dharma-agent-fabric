import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { gateSource, headlessTaskGateErrors, parseVersion, readGate } from './verify-headless-task-gate.mjs';

const repository = resolve(import.meta.dirname, '..');
const v = (text) => parseVersion(text);
// A release history: each release maps to the gate it defines, or null without the guard.
const history = (entries) => {
  const gates = new Map(entries.map(([release, gate]) => [release, gate && v(gate)]));
  const read = [];
  return {
    releases: [...gates.keys()].map(v),
    gateAt: (release) => { read.push(release.join('.')); return gates.get(release.join('.')) ?? null; },
    read,
  };
};

test('the gate in the CLI source is readable', () => {
  assert.ok(readGate(readFileSync(resolve(repository, gateSource), 'utf8')));
  assert.deepEqual(readGate('const WINDOWS_HEADLESS_TASK_SINCE = [0, 2, 226];'), [0, 2, 226]);
  assert.equal(readGate('const LEGACY_WINDOWS_TASK_EXECUTE = "powershell.exe";'), null);
});

test('before any release carries the guard, a gate above every release passes on main', () => {
  const releases = history([['0.2.224', null], ['0.2.225', null]]);
  assert.deepEqual(headlessTaskGateErrors({ gate: v('0.2.226'), version: v('0.2.214'), ...releases }), []);
  assert.deepEqual(releases.read, ['0.2.225']);
});

test('a release that shipped without the guard at the gate version fails the check', () => {
  // 0.2.226 shipped without this change; the change is picked into 0.2.227.
  const releases = history([['0.2.225', null], ['0.2.226', null]]);
  const errors = headlessTaskGateErrors({ gate: v('0.2.226'), version: v('0.2.214'), ...releases });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /release 0\.2\.226 shipped without the headless guard/);
});

test('the release in progress that first carries the guard must set the gate to its own version', () => {
  const releases = history([['0.2.225', null], ['0.2.226', null]]);
  const errors = headlessTaskGateErrors({ gate: v('0.2.228'), version: v('0.2.227'), ...releases });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CLI 0\.2\.227 is the first release .* Set it to 0\.2\.227/);
  assert.deepEqual(headlessTaskGateErrors({ gate: v('0.2.227'), version: v('0.2.227'), ...releases }), []);
});

test('once released, the gate must equal the first release that carries the guard', () => {
  const releases = history([['0.2.225', null], ['0.2.226', null], ['0.2.227', '0.2.227'], ['0.2.228', '0.2.227']]);
  assert.deepEqual(headlessTaskGateErrors({ gate: v('0.2.227'), version: v('0.2.228'), ...releases }), []);
  assert.deepEqual(releases.read, ['0.2.228', '0.2.227', '0.2.226']);
  for (const gate of ['0.2.226', '0.2.228']) {
    const errors = headlessTaskGateErrors({ gate: v(gate), version: v('0.2.228'), ...releases });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /0\.2\.227 is the first release that carries the headless guard/);
  }
});

test('versions compare numerically, not as text', () => {
  const releases = history([['0.2.22', null], ['0.2.225', null]]);
  assert.match(headlessTaskGateErrors({ gate: v('0.2.30'), version: null, ...releases })[0], /release 0\.2\.225 shipped/);
});

test('missing release tags or a missing gate fail instead of passing silently', () => {
  assert.match(headlessTaskGateErrors({ gate: v('0.2.226'), version: v('0.2.214'), releases: [], gateAt: () => null })[0], /No release tags/);
  assert.match(headlessTaskGateErrors({ gate: null, version: v('0.2.214'), releases: [v('0.2.225')], gateAt: () => null })[0], /must define/);
});

test('the gate check runs as part of npm run check', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  assert.equal(scripts['headless-gate:check'], 'node --test scripts/verify-headless-task-gate.test.mjs && node scripts/verify-headless-task-gate.mjs');
  assert.ok(scripts.check.includes('npm run headless-gate:check'));
});
