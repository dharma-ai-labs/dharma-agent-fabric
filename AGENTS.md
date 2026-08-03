# AGENTS.md - Dharma Agent Fabric Engineering Contract

## Product boundary

Dharma Agent Fabric is a local-to-cloud control system for coding agents. It is not a generic remote-administration agent, employee-surveillance product, arbitrary shell service, or replacement for the customer's coding-agent provider.

## Required architecture

- One user-level local relay per operating-system user.
- Provider-specific adapters for configured assets, session evidence, task execution, and activation behavior.
- Complete raw evidence retained locally in an encrypted content-addressed vault.
- Adaptive deep sync to the server after secret filtering, workspace qualification, normalization, deduplication, compression, and relevance selection.
- Persistent outbound-only relay connection.
- Signed task, evidence, message, and skill-release envelopes.
- Git-worktree isolation for server-initiated repository mutations.
- Immutable signed skill bundles built from customer-specific skill branches.
- Automatic installation, activation verification, installation receipts, and rollback.
- Deterministic evaluation before model-based judging where possible.
- Organization-scoped data, credentials, budgets, billing, retention, and audit.

## Repository rules

1. Use npm workspaces and Node.js `>=22.20.0 <25.0.0` for compatibility with Better Harness.
2. Keep the Better Harness fork or subtree in a clearly isolated upstream directory. Minimize direct edits so upstream updates remain reviewable.
3. Do not import private helpers across package boundaries. Depend only on public package surfaces.
4. One module owns one business capability. Avoid generic `core`, `utils`, or `common` catch-all packages.
5. Define runtime contracts in `schemas/`. TypeScript types and tests must agree with the schema revision.
6. All protocol envelopes include `schema`, `organizationId`, a unique identity, timestamp, expiry where relevant, and integrity metadata.
7. JSON and JSONL output is parser-safe. Human-readable logs and warnings go to stderr.
8. Every write-capable command supports `--dry-run` or a separate plan phase.
9. Server-originated tasks may not contain arbitrary unbounded shell text. Commands must match the workspace's approved command policy.
10. Never log secrets, raw authorization headers, raw device credentials, private keys, `.env` values, or full unredacted transcript payloads.
11. Keep evidence states explicit: `observed`, `partial`, `unavailable`, `excluded`, `redacted`, `out_of_window`, and `not_supported` are not interchangeable.
12. Static agent assets prove configuration, not runtime use. Session evidence proves observed behavior only within its workspace, provider, and time boundary.
13. A successful retry is operational recovery, not proof that the original failure was diagnosed or remediated.
14. A machine-generated skill or rubric is a proposal, not an authoritative release.
15. An installed branch head is forbidden. Install only immutable bundles pinned to commits and hashes.

## Testing contract

Each independently reviewable task must include:

- a failing test before implementation;
- unit coverage for success and failure paths;
- protocol-schema validation;
- path and case behavior on Windows and POSIX fixtures where relevant;
- secret-leakage fixtures;
- workspace-positive and workspace-negative fixtures;
- replay, expiry, signature, and idempotency fixtures for network envelopes;
- deterministic installation and rollback fixtures for skill releases;
- exact commands and results recorded in the pull request.

## Security defaults

- Outbound-only network connection.
- TLS plus device-bound application signatures.
- Device enrollment through OAuth device authorization and an Ed25519 keypair stored in the operating-system keychain.
- Default-deny task authority.
- No direct merge or deployment authority.
- No user-home collection unless the organization policy and local user scope permit it.
- No cross-repository collection unless each workspace is registered.
- Per-organization encryption keys and object-store prefixes.
- Short-lived server access tokens and revocable device certificates.
- Tamper-evident audit events for task dispatch, evidence expansion, skill release, installation, rollback, and model-judge use.

## Required terminology

Use:

- local relay
- adaptive deep sync
- trajectory capsule
- evidence expansion
- organization skill repository
- skill authoring branch
- signed skill bundle
- rubric authoring service
- integrity-contract proposal generator
- policy and skill remediation engine
- managed environment
- BYOK execution

Do not use:

- integrity-contract compiler as a current product capability
- self-healing without validation and release authority
- full-session capture when the payload is reduced or incomplete
- production proof for staged, simulated, or production-path evidence
- zero-touch onboarding when setup remains operator-assisted

## Commit discipline

Use small conventional commits:

- `feat(relay): ...`
- `feat(evidence): ...`
- `feat(tasks): ...`
- `feat(skills): ...`
- `feat(eval): ...`
- `fix(security): ...`
- `test(protocol): ...`
- `docs(agent-fabric): ...`

Every commit should leave the repository in a testable state.
