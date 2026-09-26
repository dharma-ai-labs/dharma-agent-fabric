# Lifecycle and SQLite reference adapter

Private reference package `0.1.0`, using Agent Fabric SDK `0.1.10`.
Requires Node `>=22.20.0 <25` and npm `>=10.9.3 <12`.
This is fixture-qualified integration code, not a production-enabled CLI command.
It does not enroll a device, attach a desktop chat, or replace a scheduler.

## Integration Boundary

The customer retains its orchestrator, provider accounts, history schema, job
ownership, and human publishing/spending approvals. A customer-owned lifecycle
hook supplies a **separate approved export database**, or an existing approved
read-only projection. The adapter never creates a view or writes to that source.
Do not change the original history schema merely to run this reference.

The projection must expose `dharma_lifecycle_export_v1` with:

| Column | Contract |
|---|---|
| `sequence` | Positive, unique, increasing safe integer; never reused |
| `event_json` | Immutable JSON conforming to `schemas/lifecycle-event.schema.json` |

Export only approved, bounded summaries and registered evidence references,
not an entire SQLite transcript. Preserve a customer-side mapping from job ID
to event ID/revision and actual Dharma source task/endpoint IDs. A new approved
revision is a new sequence, not an edit of a consumed row. Events expire within
15 minutes; old history is not a request to launch new work. Historical learning
ingestion requires its separate supported evidence and learning-policy flow.

Supported boundaries are:

- Coding: reviewed plan to implementation; implementation to review.
- Creative: approved brief to draft; draft to review.

Each event pins one organization, repository binding, source workspace/endpoint,
eligible target workspace/endpoint, source commit/content hash, and an existing
eligible source task. No IDs are inferred from a label, newest transcript, or
SQLite row number. A target endpoint is not proof of an attached live chat.

## Authorization and Data

Provide `authorize(metadata)` backed by the current organization source policy,
disclosure approval, endpoint/repository eligibility, revocation state, and
customer budget reservation. It must return `{approved: false}` or
`{approved: true, policyRevision: 'your-current-revision'}`. A fixture's unconditional
approval callback is **not** a production authorization implementation. The
callback sees IDs/hashes, not raw summary text: the customer hook must authorize
and sanitize the named source content before constructing the projection.

The adapter validates scope and schema before transmission and applies existing
Agent Fabric redaction to intent, summary, and missing-information strings.
Pattern-based redaction is defense in depth, not a guarantee against every
secret or malicious instruction. Do not export credentials, private graders,
unapproved paths, or third-party/customer material without disclosure approval.
Reports are evidence, not authority to expand permissions.

The SDK client uses an organization-scoped credential obtained from the approved
runtime credential provider. Never paste a one-time enrollment grant into a
config, source database, log, manifest, skill, or repository. Protect the trusted
local config and state directory with the operating system's user permissions.
Unix state files request mode `0600`; Windows access control must be established
by the host. The state contains scope/source locator hashes, event/request hashes,
cursor, process lease, IDs, and local observation receipts, not raw summaries.

## Run the Reference

From this checkout:

```sh
npm ci --ignore-scripts
npm run build
node packages/lifecycle-adapter/bin/run.mjs --config /absolute/path/approved-config.mjs
node packages/lifecycle-adapter/bin/run.mjs --config /absolute/path/approved-config.mjs --apply
```

The first invocation defaults to metadata-only dry-run: no SDK client or state
database is created, but your authorization callback still runs. A Windows config
path must also be absolute. `--apply` is an explicit dispatch boundary; a lifecycle
hook may invoke it under the standing policy after customer qualification.

Your trusted config module exports an object with these fields:

```js
import { AgentFabricClient } from '@dharma-ai-labs/agent-fabric-sdk';
import { approvedLifecycleConfig, authorizeEvent, runtimeCredential } from './customer-hooks.mjs';

export default {
  // Actual registered IDs, paths and stable stream UUID come from customer hooks.
  ...approvedLifecycleConfig,
  authorize: authorizeEvent,
  createClient: () => new AgentFabricClient({
    organizationId: approvedLifecycleConfig.scope.organizationId,
    token: runtimeCredential,
    baseUrl: 'https://www.dharma-ai.io',
  }),
};
```

`customer-hooks.mjs` is customer-owned integration work, not a supplied module.
`approvedLifecycleConfig` includes absolute `sourcePath` and separate `statePath`,
stable `streamId`, and `scope` containing `organizationId`, `repositoryBindingId`,
`workspaceId`, `sourceEndpointId`, and approved `targets` pairs of `endpointId` and
`workspaceId`. Optional `batchSize` is 1-100 (default 20); request timeout is
1-30,000 ms (default 15,000). Omit `now` outside deterministic tests. Schedule
subsequent batches using the existing scheduler; this runner is not a daemon.

## Outcomes and Recovery

`drained` means one bounded batch was consumed; inspect its cursor and processed
entries. It does not mean the entire stream is empty. `dispatched` means a
strictly attributed upstream `offered` task/message response was received.
`duplicate` suppresses another dispatch of the same immutable revision.
`expired` means the event was never dispatched. Every result includes
`executionVerified: false`: inspect the actual task outcome, receiver's answer,
and independent acceptance before declaring execution successful. Local
observation hashes are not signed upstream execution receipts.

On response loss, reopen the same state and retry the unchanged approved event.
The body hash and SDK idempotency key remain fixed. This depends on upstream
idempotency; fixture deduplication is not a production exactly-once claim.
Source and state aliases/hard-links are rejected. An unrelated state database or
a state reused for a different scope is rejected. Live local process ownership
blocks concurrent dispatch; a dead same-host PID can be reclaimed. Shared-host
state and PID reuse can conservatively block recovery.

Typed blocked results retain the cursor:

- `lifecycle_policy_denied`: current approval revoked or unavailable; do not bypass.
- `lifecycle_scope_mismatch`: incorrect organization/repository/endpoint mapping.
- `lifecycle_transport_unavailable`: no verified response; reconcile or retry while valid.
- `lifecycle_response_invalid`: response attribution/contract failed; inspect upstream IDs.
- `lifecycle_projection_conflict`: a previously attempted revision changed.
- `lifecycle_consumed_history_changed`: last consumed row disappeared or changed.
- `lifecycle_pending_expired`: an attempted event expired without a verified response;
  reconcile the upstream task before making a new authorized event. This is not cancellation.

Do not delete state or reset the cursor to conceal a pending outcome. Detection
checks the last consumed row and attempted revision hashes, not all historical
rows; the customer projection must retain append-only history. No automatic
publishing, spending, permission expansion, or scheduler replacement is authorized
by the handoff. Behavioral learning, signed activation, and rollback remain
separate product gates; this adapter alone cannot demonstrate them.

## Qualification

Run `npm test --workspace @dharma-ai-labs/agent-fabric-lifecycle-adapter` after build.
Synthetic tests cover all four boundaries, read-only source bytes, redaction,
scope/policy denial, fixed replay after actual process exit, local SDK transport,
concurrent ownership, expiry, immutable history, hard-links, strict response
attribution, and default dry-run. No real provider answer or customer ingestion
is represented by these tests. Qualify the actual customer hook, source-task
registration, live service, and selected agent/session before enabling dispatch.
