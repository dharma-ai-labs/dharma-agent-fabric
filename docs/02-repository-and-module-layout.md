# Repository and Module Layout

## Recommended repository strategy

Use two repositories initially:

1. **Public `dharma-agent-fabric` repository** for the open-source local CLI, relay, provider adapters, protocol schemas, public Skill, and plugin metadata.
2. **Private `cognitive_integrity` or control-plane repository** for multi-tenant ingestion, orchestration, evaluation, remediation, billing, GitHub App logic, and MCP server.

The public repository must not contain customer-specific skill content, proprietary evaluator prompts, shared Failure Atlas data, or server secrets.

## Public repository layout

```text
dharma-agent-fabric/
├── AGENTS.md
├── README.md
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── package.json
├── package-lock.json
├── schemas/
│   ├── agent-event.schema.json
│   ├── trajectory-capsule.schema.json
│   ├── evidence-request.schema.json
│   ├── task-envelope.schema.json
│   ├── agent-message.schema.json
│   ├── skill-manifest.schema.json
│   ├── skill-bundle.schema.json
│   └── install-receipt.schema.json
├── upstream/
│   └── better-harness/
├── packages/
│   ├── contracts/
│   ├── policy/
│   ├── provider-adapters/
│   ├── local-vault/
│   ├── evidence-reduction/
│   ├── relay-protocol/
│   ├── task-runner/
│   ├── a2a-client/
│   ├── skill-manager/
│   ├── updater/
│   └── cli/
├── apps/
│   └── relay-daemon/
├── plugins/
│   ├── codex/
│   ├── claude/
│   ├── cursor/
│   └── shared-skill/
├── fixtures/
├── test/
└── docs/
```

## Private control-plane layout

```text
cognitive_integrity/
├── apps/
│   ├── organization-api/
│   ├── relay-gateway/
│   ├── mcp-server/
│   └── operator-console/
├── services/
│   ├── device-registry/
│   ├── trajectory-ingest/
│   ├── evidence-request/
│   ├── task-broker/
│   ├── a2a-broker/
│   ├── orchestrator/
│   ├── deterministic-evals/
│   ├── judge-service/
│   ├── rubric-authoring/
│   ├── failure-atlas/
│   ├── remediation-engine/
│   ├── replay-runner/
│   ├── skill-release/
│   ├── github-app/
│   ├── managed-runner/
│   ├── billing/
│   └── audit/
├── packages/
│   ├── contracts/
│   ├── authz/
│   ├── persistence/
│   ├── object-storage/
│   ├── eventing/
│   ├── model-gateway/
│   └── telemetry/
├── migrations/
├── test/
└── docs/
```

## Public package responsibilities

### `packages/contracts`

- Generated or validated TypeScript types.
- Schema identifiers and revision registry.
- Envelope canonicalization for signatures.
- No network or storage logic.

### `packages/policy`

- Organization policy parsing.
- Local user overrides that may narrow but not broaden organization authority.
- Path, command, provider, evidence-depth, retention, and task-policy evaluation.
- Policy decision receipts.

### `packages/provider-adapters`

- Adapter registry.
- Better Harness adapter bridges.
- Capability probing.
- Workspace binding.
- Task and activation interfaces.
- No organization or network policy.

### `packages/local-vault`

- Encryption-key access.
- SQLite metadata.
- Content-addressed blob storage.
- Retention and garbage collection.
- Local disclosure receipts.

### `packages/evidence-reduction`

- Event normalization.
- Secret detection and redaction.
- Deduplication.
- Relevance selection.
- Compression.
- TrajectoryCapsule assembly.

### `packages/relay-protocol`

- WebSocket session.
- HTTP fallback.
- Signed envelope verification.
- Replay cache.
- Cursor and resumable delivery.
- No business-specific task execution.

### `packages/task-runner`

- Git worktree lifecycle.
- Provider process launch.
- Command and path enforcement.
- Task state machine.
- Cancellation, timeout, commit, and branch push.

### `packages/a2a-client`

- Conversation and message state.
- Structured handoff envelopes.
- Offline queue.
- Evidence references.

### `packages/skill-manager`

- Bundle download.
- Signature and hash verification.
- Host-specific staged installation.
- Discovery and activation smoke.
- Atomic activation and rollback.
- Receipt generation.

### `packages/updater`

- CLI and relay binary updates.
- Signed release channels.
- Separate from organization skill updates.

### `packages/cli`

- Human and machine command surface.
- Thin dispatch to package APIs.
- No product logic.

## Private service responsibilities

Each service owns one business capability and a stable API. Avoid one large `agent-fabric-service` that mixes ingestion, task dispatch, evaluation, skills, and billing.

## Shared contract strategy

The canonical schemas live in the public repository. The private control plane consumes an exact released version of `@dharma-ai/agent-fabric-contracts`.

Rules:

- Additive optional fields may use a minor schema revision.
- Removed or meaningfully changed fields require a new schema major version.
- Devices advertise supported schema revisions.
- The server may down-convert only when the conversion is deterministic and loss is explicit.
- Signed envelopes canonicalize field order and representation before signing.

## Better Harness upstream boundary

Use either:

- a Git subtree under `upstream/better-harness`, or
- a maintained fork with a pinned upstream remote.

Prefer an adapter layer over invasive modification. Upstream-derived modules should remain recognizable so security and behavior updates can be reviewed and merged.

## Package naming

Use business-specific package names. Do not create:

- `packages/core`
- `packages/common`
- `packages/utils`
- `packages/shared`

Small generic helpers should remain inside the capability that owns them until a second real consumer requires promotion.
