import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {parseNamedCodexSkillObservation} from './namedCodexSkillDiscovery.js';

const good = () => ({schema: 'dharma.named-codex-skill-observation/v1', nativeDiscovered: true,
  bundleId: randomUUID(), bundleHash: `sha256:${'a'.repeat(64)}`, catalogHash: `sha256:${'b'.repeat(64)}`,
  manifestHash: `sha256:${'c'.repeat(64)}`, skillsHash: `sha256:${'d'.repeat(64)}`, observedAt: new Date().toISOString()});

test('native skill IPC observation snapshots only the exact current non-secret content identity', () => {
  const input = good(), result = parseNamedCodexSkillObservation(input);
  assert.deepEqual(result, input); assert.equal(Object.isFrozen(result), true);
  input.bundleHash = `sha256:${'e'.repeat(64)}`;
  assert.notEqual(result.bundleHash, input.bundleHash);
});

test('native skill IPC observation rejects malformed, stale, future and private fields', () => {
  const fixture = good();
  const {catalogHash: _catalog, ...partial} = fixture;
  for (const value of [partial, {...fixture, path: '/private/native/SKILL.md'}, {...fixture, schema: 'foreign'},
    {...fixture, nativeDiscovered: false}, {...fixture, bundleId: `${fixture.bundleId}\n`},
    {...fixture, manifestHash: `${fixture.manifestHash}\n`}, {...fixture, skillsHash: 'not-a-hash'},
    {...fixture, observedAt: new Date(Date.now() - 60_001).toISOString()},
    {...fixture, observedAt: new Date(Date.now() + 60_000).toISOString()}, {...fixture, observedAt: 'invalid'},
    {...fixture, observedAt: fixture.observedAt.replace('Z', '+00:00')}, []]) {
    assert.throws(() => parseNamedCodexSkillObservation(value), {message: 'named_session_native_skill_invalid'});
  }
});

test('native skill IPC observation never invokes accessors or proxy traps', () => {
  let invoked = 0;
  const getter = {...good()};
  Object.defineProperty(getter, 'bundleHash', {enumerable: true, get() {invoked++; return 'private';}});
  const proxy = new Proxy(good(), {ownKeys() {invoked++; return [];}});
  for (const value of [getter, proxy, Object.assign(Object.create({private: true}), good())]) {
    assert.throws(() => parseNamedCodexSkillObservation(value), {message: 'named_session_native_skill_invalid'});
  }
  assert.equal(invoked, 0);
});
