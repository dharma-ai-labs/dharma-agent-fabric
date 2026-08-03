# Security, Privacy, and Threat Model

## Security posture

Dharma Agent Fabric has deep access to developer trajectories and can execute repository tasks. The system must be designed as a high-trust developer infrastructure product, not as a convenience plugin.

## Protected assets

- source code;
- prompts and agent conversations;
- Git history and diffs;
- command output;
- credentials and secrets;
- customer and employee identity;
- proprietary Skills and policies;
- hidden eval truth;
- remediation logic;
- device keys;
- organization billing and usage;
- release and rollback authority.

## Principal threats

### T1. Secret exfiltration

A trajectory contains an API key, `.env` value, connection string, private key, or token.

**Controls:** local secret filtering, path exclusion, value-level tests, no raw logs, expansion re-filtering, customer patterns, incident revocation.

### T2. Cross-workspace evidence contamination

A provider's global session store includes unrelated repositories.

**Controls:** exact workspace binding, positive and negative fixtures, canonical path handling, no unqualified global session ingestion.

### T3. Malicious or compromised server task

The server sends a broad command or attempts to read unrelated local data.

**Controls:** outbound-only connection, signed typed tasks, local default-deny policy, exact workspace, approved commands, worktrees, expiry, replay protection, local rejection.

### T4. Compromised relay device

An attacker steals device credentials or local vault access.

**Controls:** OS keychain, encrypted vault, revocable device key, short-lived sessions, device posture, no reusable organization admin token, remote revocation.

### T5. Supply-chain attack through skill update

A malicious or accidental Skill release reaches all agents.

**Controls:** branch and release separation, exact commits, deterministic bundle, signatures, risk classification, no self-approval, canaries, activation smoke, rollback.

### T6. Judge leakage

Hidden truth or held-out cases become visible to the agent under evaluation.

**Controls:** separate stores and identities, freeze output before judge context, no shared prompt cache, audit input hashes, leakage tests.

### T7. Cross-tenant data access

One organization accesses another's trajectories, tasks, Skills, or receipts.

**Controls:** organization-bound authorization, tenant-scoped database queries, object-store prefixes, per-organization keys, row-level security as defense in depth, negative tests.

### T8. Employee surveillance misuse

Managers use trajectory data for covert personnel monitoring unrelated to agent reliability.

**Controls:** clear employee disclosure, purpose limitation, role-based access, workspace boundaries, retention controls, derived team reporting by default, audit of content access, local visibility.

### T9. Unbounded model cost

A server loop repeatedly invokes judges or managed agents.

**Controls:** purpose-specific budgets, hard caps, idempotency, model allowlists, recursion limit, approval threshold, cost receipts.

### T10. Remote task escapes worktree

A task modifies the active developer workspace or external path.

**Controls:** canonical path containment, OS sandbox where possible, worktree root enforcement, write interception, command policy, post-task diff audit.

## Data classification

| Class | Examples | Default handling |
| --- | --- | --- |
| Restricted | secrets, credentials, private keys | Never uploaded; redact locally |
| Confidential source | code, diffs, prompts, transcripts | Upload only under workspace policy; encrypt and retain narrowly |
| Sensitive identity | names, emails, home paths | Pseudonymize unless operationally required |
| Internal metadata | task IDs, provider versions, skill versions | Organization-scoped storage |
| Public | open-source Skill docs, public plugin metadata | Public repository permitted |

## Organization policy and employee disclosure

Before `reduced_full_session` or `incident_capture` is enabled, the organization must define:

- repositories in scope;
- participants and roles;
- evidence purpose;
- content categories;
- local and server retention;
- who can inspect raw excerpts;
- whether employee-level identity is visible;
- whether evidence may be used for performance management;
- model providers used for analysis;
- cross-customer reuse policy;
- deletion and subject-access process;
- incident process.

The CLI displays the active policy and current upload preview.

## Local user controls

The user can:

- view pending capsule contents;
- view redactions and omissions;
- pause one workspace;
- reject a task that requires local confirmation;
- inspect installed Skills;
- revoke the device;
- request local deletion when policy permits.

## Cryptography

### Device identity

- Ed25519 signing key.
- Public key registered with device.
- Rotation and revocation supported.

### Local vault

- XChaCha20-Poly1305 or AES-256-GCM.
- Master key sealed by OS keychain.
- Per-blob nonce.
- Authenticated metadata.

### Transport

- TLS 1.3.
- Application-level signed envelopes.
- Optional mTLS for enterprise deployments.

### Server storage

- Per-organization KMS envelope encryption.
- Separate object prefixes and access policies.
- Encrypted backups.
- Key rotation and deletion process.

### Skill releases

- Ed25519 or Sigstore-compatible signing.
- Exact bundle hash and source commits.
- Offline-verifiable public release key.

## Authorization model

Actors:

- local developer;
- organization member;
- organization agent operator;
- eval owner;
- skill author;
- skill release approver;
- security approver;
- device;
- local relay;
- managed worker;
- GitHub App;
- MCP app client.

Capabilities are named and narrow. Examples:

```text
agent_fabric.devices.read
agent_fabric.devices.manage
agent_fabric.trajectories.read
agent_fabric.evidence.request
agent_fabric.tasks.create
agent_fabric.tasks.cancel
agent_fabric.messages.send
agent_fabric.evals.create
agent_fabric.remediations.propose
agent_fabric.skills.edit
agent_fabric.skills.release
agent_fabric.skills.rollback
agent_fabric.billing.read
```

A human role does not automatically grant device or task authority.

## Audit

Tamper-evident audit events are required for:

- login and enrollment;
- device key rotation or revocation;
- workspace registration;
- evidence policy change;
- capsule upload;
- expanded evidence request and response;
- raw excerpt inspection;
- task creation, acceptance, cancellation, and completion;
- A2A message delivery;
- judge invocation;
- rubric proposal;
- remediation PR;
- skill release, install, activation, and rollback;
- cost-cap decision;
- data deletion.

## Retention

Configure separately:

- raw local evidence;
- reduced server content;
- structured metadata;
- eval datasets;
- remediation evidence;
- audit receipts;
- backups.

Deletion must propagate through primary stores, derived assets where traceable, and backup expiry. Immutable audit may retain non-content evidence of the deletion action.

## Security acceptance gates

Before pilot:

- secret-leakage fixture suite passes;
- cross-workspace negative tests pass;
- task path escape tests pass;
- replay and expiry tests pass;
- skill signature and rollback tests pass;
- tenant isolation tests pass;
- device revocation test passes;
- a documented employee and customer data policy exists;
- an incident response owner is named.

Before broad release:

- independent security review;
- threat-model refresh;
- dependency and artifact provenance;
- signed binaries;
- secure update channel;
- penetration test of relay and control plane;
- deletion verification;
- disaster recovery exercise.
