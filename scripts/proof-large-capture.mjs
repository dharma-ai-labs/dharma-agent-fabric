#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTrajectoryCapsule } from '../packages/evidence-reduction/dist/index.js';
import { codexAdapter } from '../packages/provider-adapters/dist/index.js';

const oneGiB = 1024 ** 3;
const root = await mkdtemp(join(tmpdir(), 'dharma-large-capture-'));
const workspace = join(root, 'workspace');
const source = join(root, 'sessions');
const sessionPath = join(source, 'one-gib.jsonl');
const turnId = randomUUID();

await mkdir(workspace);
await mkdir(source);

const head = Buffer.from(`${JSON.stringify({
  type: 'session_meta',
  payload: { cwd: workspace },
  timestamp: '2026-08-05T12:00:00.000Z',
})}\n`);
const tail = Buffer.from(`\n${[
  {
    type: 'turn_context',
    payload: { turn_id: turnId, cwd: workspace },
    timestamp: '2026-08-05T12:00:01.000Z',
  },
  {
    type: 'event_msg',
    payload: { type: 'user_message', message: 'Inspect the bounded large-session evidence.' },
    timestamp: '2026-08-05T12:00:02.000Z',
  },
  {
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'The bounded evidence is sufficient for this turn.' },
    timestamp: '2026-08-05T12:00:03.000Z',
  },
].map((value) => JSON.stringify(value)).join('\n')}\n`);

const startedAt = Date.now();
try {
  const handle = await open(sessionPath, 'w', 0o600);
  try {
    await handle.truncate(oneGiB);
    await handle.write(head, 0, head.length, 0);
    await handle.write(tail, 0, tail.length, oneGiB - tail.length);
  } finally {
    await handle.close();
  }

  const sessions = await codexAdapter.discover({
    workspace,
    roots: [source],
    maximumSessions: 10,
    maximumBytesPerSession: 8 * 1024 * 1024,
    maximumRecordBytes: 256 * 1024,
  });
  const session = sessions.find((candidate) => candidate.sessionId.endsWith(turnId));
  assert.ok(session, 'The complete bounded tail turn must be discovered.');
  assert.equal(session.coverage, 'partial');
  const tailRecords = session.records.slice(-3);
  assert.deepEqual(tailRecords.map((record) => record.kind), [
    'metadata',
    'user_message',
    'agent_message',
  ]);
  assert.ok(tailRecords.every((record) => record.coverage === 'observed'));

  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_large_capture_proof',
    deviceId: randomUUID(),
    workspaceId: randomUUID(),
    session,
    policy: {
      schema: 'dharma.organization-policy/v1',
      organizationId: 'org_large_capture_proof',
      revision: 'large-capture-proof-v1',
      evidence: {
        defaultMode: 'deep',
        registeredWorkspaceOnly: true,
        excludePaths: [],
        maximumCapsuleBytes: 262_144,
        maximumDailyUploadBytes: 1_048_576,
        maximumExpansionBytes: 262_144,
        pseudonymizeIdentity: true,
      },
      tasks: {
        defaultNetwork: 'deny',
        defaultGit: 'read_only',
        allowedCommands: {},
        writePaths: [],
        requireLocalConfirmationFor: [],
      },
      skills: {
        automaticInstall: true,
        automaticPromotionMaxRisk: 'R2',
        canaryPercent: 5,
      },
      retention: {},
      budgets: {},
    },
    rawContentId: 'sha256:large-capture-proof',
    rawBytes: oneGiB,
    rawKind: 'raw-provider-turn',
  });

  const capsuleBytes = Buffer.byteLength(JSON.stringify(capsule));
  assert.ok(capsuleBytes <= 262_144);
  assert.equal(capsule.localEvidenceAvailable[0]?.bytes, oneGiB);
  assert.equal(capsule.contentIndex[0]?.uploaded, false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceBytes: oneGiB,
    boundedReadBytes: 8 * 1024 * 1024,
    capsuleBytes,
    uploadedRawEvidence: false,
    sourceCoverage: session.coverage,
    discoveredCompleteTailTurn: tailRecords.every((record) => record.coverage === 'observed'),
    eventCount: capsule.events.length,
    elapsedMs: Date.now() - startedAt,
    maximumResidentSetKb: process.resourceUsage().maxRSS,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
