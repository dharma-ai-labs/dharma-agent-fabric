import assert from 'node:assert/strict';
import test from 'node:test';
import { pinnedRollbackControllerMatches, recoverableContainerJournal } from './containerRelayRecovery.js';

const hashes = {
  'bin.js': 'a0d6df4e5e2a8576097f5045d5338f12ce7eae920fb08e9e6a80b103d42d3565',
  'index.js': 'd5def3c569bf70d6bf04eed30c77f820f5941b41911de9200abe288245b48ec1',
  'containerRelayLifecycle.js': '8c634a011fb8c0cebcc82b352dcc9b6552f86b2ac03b381ef0b2414d3bdce621',
};

test('rollback compatibility pins the exact published controller, not a version label', () => {
  assert.equal(pinnedRollbackControllerMatches('0.2.149', hashes), true);
  for (const version of ['0.2.148', '0.2.150', '0.2.151', '0.2.149\n', null]) {
    assert.equal(pinnedRollbackControllerMatches(version, hashes), false);
  }
  for (const name of Object.keys(hashes)) {
    assert.equal(pinnedRollbackControllerMatches('0.2.149', { ...hashes, [name]: '0'.repeat(64) }), false);
    const missing = { ...hashes }; delete missing[name as keyof typeof missing];
    assert.equal(pinnedRollbackControllerMatches('0.2.149', missing), false);
  }
  assert.equal(pinnedRollbackControllerMatches('0.2.149', { ...hashes, 'other.js': '0'.repeat(64) }), false);
});

test('journal compatibility admits only the demonstrated interrupted version pair', () => {
  assert.equal(recoverableContainerJournal('0.2.151', '0.2.149'), true);
  for (const [version, previous] of [['0.2.150', '0.2.149'], ['0.2.151', '0.2.148'],
    ['0.2.152', '0.2.149'], ['0.2.149', '0.2.151']]) {
    assert.equal(recoverableContainerJournal(version!, previous!), false);
  }
});
