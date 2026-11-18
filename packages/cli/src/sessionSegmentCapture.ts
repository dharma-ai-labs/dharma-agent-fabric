import type { TrajectoryCapsule } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';

export interface SessionSegmentStore {
  commit(input: {
    capsule: TrajectoryCapsule; raw: Buffer; rawContentId: string;
    localSessionId: string; sourcePath: string; observedAt: string;
  }): Promise<void>;
  head(capsule: TrajectoryCapsule): Promise<{ revision: number; capsuleHash: string } | null>;
  sync(capsule: TrajectoryCapsule): Promise<void>;
}

export interface SessionSegmentCaptureInput {
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  provider: 'claude' | 'codex';
  sources: string[];
  policy: OrganizationPolicy;
  ledgerRoot: string;
  sourceClass?: 'provider_discovery' | 'explicit_import';
  idleMinutes?: number;
  maximumUploadBytes?: number;
  maximumRecordBytes?: number;
  now?: () => Date;
  store?: SessionSegmentStore;
  validate?: (capsule: TrajectoryCapsule) => Promise<void>;
}

export interface SessionSegmentCaptureReport {
  ok: true;
  provider: 'claude' | 'codex';
  mode: 'plan' | 'sync';
  uploadedBytes: number;
  budgetExhausted: boolean;
  stoppedReason: string | null;
  sessions: Array<{
    sessionId: string; segmentsCommitted: number; segmentsSkipped: number; segmentsPlanned: number;
    held: boolean; stoppedReason: string | null;
  }>;
  segments: Array<{
    sessionId: string; trajectoryId: string; index: number; capsuleHash: string; status: string;
    coverage: string; bytes: number; recordCount: number; timeRange: { start: string; end: string };
    outcome: 'planned' | 'synced' | 'already_on_server' | 'queued';
  }>;
}

export async function captureSessionSegments(_input: SessionSegmentCaptureInput): Promise<SessionSegmentCaptureReport> {
  throw new Error('not_implemented');
}

export type RelaySessionCaptureSettings = { enabled: false } | {
  enabled: true; intervalMs: number; lookbackHours: number; idleMinutes: number; providers: Array<'claude' | 'codex'>;
};

export function relaySessionCaptureSettings(_flags: Map<string, string | boolean>): RelaySessionCaptureSettings {
  throw new Error('not_implemented');
}
