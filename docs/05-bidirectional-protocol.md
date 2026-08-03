# Bidirectional Protocol

## Transport

Use an outbound-initiated WebSocket as the primary channel and HTTPS as the bulk-upload and recovery channel.

```text
wss://relay.dharma-ai.io/v1/connect
https://api.dharma-ai.io/v1/agent-fabric/...
```

The WebSocket carries control messages and bounded progress events. Large trajectory chunks and artifacts use pre-authorized HTTPS upload URLs.

## Device session establishment

1. TLS connection.
2. Client sends `ClientHello` with device ID, supported schemas, public-key ID, nonce, and timestamp.
3. Server sends `ServerChallenge` with session ID, challenge nonce, server time, and required policy revision.
4. Client signs challenge plus canonical session context.
5. Server validates device status, key, organization, clock skew, and revocation.
6. Server returns `SessionAccepted` with heartbeat interval, cursor, policy revision, and upload endpoints.
7. Both sides maintain monotonic sequence numbers.

## Envelope requirements

Every control message includes:

```json
{
  "schema": "dharma.message/v1",
  "messageId": "uuid",
  "organizationId": "org_123",
  "deviceId": "dev_123",
  "sentAt": "2026-08-03T20:00:00Z",
  "expiresAt": "2026-08-03T20:05:00Z",
  "sequence": 42,
  "nonce": "base64url",
  "type": "TaskEnvelope",
  "payload": {},
  "signature": "base64url"
}
```

Canonicalization and signing rules belong to `packages/contracts`.

## Replay protection

- Reject expired messages.
- Reject duplicate message IDs.
- Reject non-monotonic sequence outside the documented reconnect window.
- Retain replay cache through process restart.
- Bind signatures to organization, device, session, message type, and payload hash.
- Return a signed rejection receipt without leaking sensitive policy details.

## Message families

### Connection and presence

- `ClientHello`
- `ServerChallenge`
- `ClientProof`
- `SessionAccepted`
- `Heartbeat`
- `CapabilityChanged`
- `WorkspaceChanged`
- `SessionClosing`

### Evidence

- `TrajectoryAvailable`
- `TrajectoryAccepted`
- `EvidenceRequest`
- `EvidenceResponseAvailable`
- `EvidenceRejected`
- `RetentionInstruction`

### Tasks

- `TaskOffered`
- `TaskAccepted`
- `TaskRejected`
- `TaskStarted`
- `TaskProgress`
- `TaskEvidenceAvailable`
- `TaskCompleted`
- `TaskFailed`
- `TaskCancelled`
- `TaskLeaseRenewed`

### A2A

- `AgentMessageAvailable`
- `AgentMessageAccepted`
- `AgentMessageDelivered`
- `AgentMessageResponse`
- `AgentMessageExpired`

### Skills

- `SkillReleaseAvailable`
- `SkillReleaseAccepted`
- `SkillInstallStarted`
- `SkillInstallReceipt`
- `SkillActivationReceipt`
- `SkillRollbackRequired`
- `SkillRollbackReceipt`

### Policy and device administration

- `PolicyRevisionAvailable`
- `PolicyApplied`
- `DeviceRevoked`
- `WorkspaceRevoked`
- `KeyRotationRequired`

## Delivery semantics

Use at-least-once delivery with idempotent handlers.

Every message that changes state has:

- stable message ID;
- stable operation ID;
- expected current revision when applicable;
- deterministic idempotency result;
- durable receipt.

Do not promise exactly-once delivery. Promise idempotent observable effects.

## Connection loss

### Local behavior

- Continue capture.
- Persist outbound events to spool.
- Continue an already authorized task if its lease and policy allow it.
- Stop task mutation when lease expiry is reached.
- Keep the current skill bundle.

### Server behavior

- Mark device offline after heartbeat threshold.
- Requeue tasks not accepted.
- Preserve accepted task lease until expiry.
- Do not dispatch the same mutable task to two devices unless the task explicitly supports speculative execution.

## Bulk upload flow

1. Relay sends capsule metadata and chunk manifest.
2. Server validates limits and returns scoped upload URLs.
3. Relay uploads encrypted compressed chunks.
4. Relay sends `UploadComplete` with hashes.
5. Server verifies hashes and atomically commits ingestion.
6. Server sends acceptance receipt and durable cursor.

## Server-initiated evidence expansion

The server may request only local content references advertised by the capsule or selectors permitted by policy. It cannot send a raw local path and ask the relay to read it unless that path is already within the registered workspace and the request authority explicitly permits path selection.

## Version negotiation

- Client advertises schema major and minor revisions.
- Server chooses the highest mutually supported compatible version.
- Unsupported required schema prevents that message family, not the entire connection when safe degradation is possible.
- Capability inventory identifies disabled message families.

## Protocol audit

Every accepted or rejected state-changing envelope produces an audit record containing:

- actor;
- organization;
- device;
- workspace;
- operation type;
- request hash;
- authority decision;
- outcome;
- timestamp;
- policy revision;
- related receipt.

Audit records exclude raw secrets and full transcript content.
