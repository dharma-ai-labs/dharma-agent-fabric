// Published 0.2.149, source 633a031eeca938ce9bc5a304ae3747fa65352625.
// This is rollback compatibility, not general acceptance of older controllers.
const PINNED_CONTROLLER = {
  'bin.js': 'a0d6df4e5e2a8576097f5045d5338f12ce7eae920fb08e9e6a80b103d42d3565',
  'index.js': 'd5def3c569bf70d6bf04eed30c77f820f5941b41911de9200abe288245b48ec1',
  'containerRelayLifecycle.js': '8c634a011fb8c0cebcc82b352dcc9b6552f86b2ac03b381ef0b2414d3bdce621',
} as const;

export function pinnedRollbackControllerMatches(version: unknown, hashes: Record<string, string>) {
  return version === '0.2.149' && Object.keys(hashes).length === Object.keys(PINNED_CONTROLLER).length
    && Object.entries(PINNED_CONTROLLER).every(([name, expected]) => Object.hasOwn(hashes, name) && hashes[name] === expected);
}

export function recoverableContainerJournal(version: string, previousVersion: string) {
  return version === '0.2.151' && previousVersion === '0.2.149';
}
