import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  TRAJECTORY_SEGMENT_TOO_LARGE,
  buildTrajectoryCapsule,
  trajectorySegmentSessionLink,
} from './index.js';

const policy = (maximumCapsuleBytes = 100_000): OrganizationPolicy => ({
  schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: 'rev_1',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes,
    maximumDailyUploadBytes: 1_000_000, maximumExpansionBytes: 100_000, pseudonymizeIdentity: true,
  },
  tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
  retention: {}, budgets: {},
});

const session = (records: number) => ({
  provider: 'claude' as const,
  sessionId: 'claude-0123456789abcdef01234567',
  sourcePath: '/private/session.jsonl',
  workspace: '/repo',
  coverage: 'observed' as const,
  startedAt: '2026-11-18T10:00:00.000Z',
  endedAt: '2026-11-18T10:30:00.000Z',
  records: Array.from({ length: records }, (_, index) => ({
    native: { type: index % 2 ? 'assistant' : 'user', uuid: `record-${index}` },
    sourcePath: '/private/session.jsonl', line: index + 1, workspace: '/repo',
    timestamp: new Date(Date.UTC(2026, 10, 18, 10, 0, index)).toISOString(),
    kind: index % 2 ? 'agent_message' : 'user_message', coverage: 'observed' as const,
  })),
});

const base = {
  organizationId: 'org_test', deviceId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333', rawContentId: `sha256:${'a'.repeat(64)}`, rawBytes: 128,
};

test('session segments have stable distinct identities linked to one pseudonymous session', () => {
  const whole = buildTrajectoryCapsule({ ...base, session: session(4), policy: policy() });
  const first = buildTrajectoryCapsule({ ...base, session: session(4), policy: policy(), segment: { index: 0 } });
  const firstAgain = buildTrajectoryCapsule({ ...base, session: session(4), policy: policy(), segment: { index: 0 } });
  const second = buildTrajectoryCapsule({ ...base, session: session(4), policy: policy(), segment: { index: 1 } });

  assert.equal(first.trajectoryId, firstAgain.trajectoryId);
  assert.equal(first.capsuleHash, firstAgain.capsuleHash);
  assert.notEqual(first.trajectoryId, second.trajectoryId);
  assert.notEqual(first.trajectoryId, whole.trajectoryId, 'a segment never reuses the whole-session trajectory');
  assert.equal(first.sessionId, `${whole.sessionId}:segment:000000`);
  assert.equal(second.sessionId, `${whole.sessionId}:segment:000001`);
  assert.ok(first.events.every((event) => event.sessionId === first.sessionId));
  assert.deepEqual(trajectorySegmentSessionLink(second.sessionId), { sessionId: whole.sessionId, index: 1 });
  assert.equal(trajectorySegmentSessionLink(whole.sessionId), null);
  assert.match(first.sessionId, /^[A-Za-z0-9_.:-]{1,2048}$/, 'the HQ pseudonymous session grammar accepts the segment link');
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.coverage, { state: 'observed', admittedSessions: 1, excludedSessions: 0, missingFields: [] });
});

test('a segment that exceeds the capsule limit is refused instead of collapsed to partial', () => {
  const small = policy(4_000);
  assert.throws(
    () => buildTrajectoryCapsule({ ...base, session: session(80), policy: small, segment: { index: 2 } }),
    (error: Error) => error.message === TRAJECTORY_SEGMENT_TOO_LARGE,
  );
  const collapsed = buildTrajectoryCapsule({ ...base, session: session(80), policy: small });
  assert.equal(collapsed.status, 'partial', 'unsegmented capture keeps its existing size collapse');
  const fitting = buildTrajectoryCapsule({ ...base, session: session(4), policy: small, segment: { index: 2 } });
  assert.ok(Buffer.byteLength(canonicalize(fitting)) <= 4_000);
  assert.equal(fitting.status, 'completed');
});

test('segment indexes are bounded integers', () => {
  for (const index of [-1, 1.5, 1_000_000]) {
    assert.throws(() => buildTrajectoryCapsule({ ...base, session: session(2), policy: policy(), segment: { index } }),
      /segment index/);
  }
});
