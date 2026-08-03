# Testing and Verification

## Test philosophy

A passing unit suite does not prove a host, device, or deployment works. The system needs layered evidence from deterministic fixtures through real-host and end-to-end smokes.

## Unit tests

Cover:

- schema validation;
- canonical signature input;
- policy parsing and narrowing;
- secret detection and redaction;
- path normalization;
- content hashing;
- deduplication;
- capsule revisioning;
- replay and expiry;
- task state transitions;
- command allowlists;
- worktree containment;
- skill bundle verification;
- activation and rollback;
- cost hard caps;
- tenant-bound repository methods.

## Provider adapter fixtures

For every provider:

- positive workspace match;
- foreign workspace rejection;
- missing cwd;
- Windows and POSIX paths;
- spaces, Unicode, punctuation, and case;
- symlink and canonical path;
- unknown event types;
- missing usage fields;
- cancelled, failed, and successful tool calls;
- duplicate source files;
- secret-shaped content;
- partial transcript and audit coverage.

## Protocol tests

- valid handshake;
- invalid device signature;
- expired message;
- duplicate message ID;
- sequence rewind;
- reconnect and cursor resume;
- chunk hash mismatch;
- idempotent duplicate upload;
- task lease expiry;
- duplicate task offer;
- offline message delivery;
- device revocation during task;
- skill release replay;
- policy revision mismatch.

## Local vault tests

- encrypted-at-rest assertion;
- atomic write recovery;
- corrupted blob detection;
- key loss behavior;
- retention and garbage collection;
- disclosure receipt integrity;
- no plaintext secret in metadata, log, or crash output;
- spool restart and resume.

## Task-runner tests

- worktree created outside active workspace;
- write path escape denied;
- command not in registry denied;
- network policy enforced;
- provider process cancellation;
- timeout;
- acceptance failure;
- commit and task branch only;
- no default-branch merge;
- branch push idempotency;
- active Skill bundle pinned.

## Skill tests

- deterministic bundle build;
- source commit and hash match;
- bad signature rejected;
- wrong organization rejected;
- wrong provider target rejected;
- staged install does not alter active version;
- activation smoke;
- next-session activation semantics;
- forced canary failure;
- automatic rollback;
- installation receipt signature;
- running task remains pinned.

## Server tests

- organization and tenant isolation;
- device and workspace authorization;
- object-storage prefix isolation;
- evaluation hidden-truth separation;
- judge usage and cost receipt;
- budget cap;
- GitHub App repository boundary;
- remediation producer cannot approve high-risk release;
- rollout cohort selection;
- rollback fanout;
- MCP tool source permission enforcement.

## End-to-end vertical slices

### E2E-1: local capture

Codex fixture session -> local vault -> reduced capsule -> schema validation -> no network.

### E2E-2: remote sync

Relay -> authenticated connection -> capsule upload -> server receipt -> reconnect without duplicate.

### E2E-3: evidence expansion

Server request -> local policy -> exact span -> filtering -> upload -> disclosure receipt.

### E2E-4: local task

Server task -> worktree -> Codex or Claude -> test -> commit -> task branch -> final evidence.

### E2E-5: A2A

Managed agent -> local agent -> structured handoff -> local response -> conversation lineage.

### E2E-6: skill release

Failure family -> remediation PR -> held-out pass -> signed bundle -> canary install -> activation -> expansion.

### E2E-7: rollback

Bad bundle -> canary health failure -> prior bundle restored -> receipt and task recovery.

### E2E-8: BYOK billing

Local provider task -> no Dharma model token charge -> server judge -> Analysis Token charge only.

## Native host smoke

A provider is public only after:

- installed real host version recorded;
- source discovery verified;
- configured assets verified;
- session capture verified;
- task invocation verified when claimed;
- skill discovery and activation verified;
- evidence limitations documented.

## Cross-platform CI

Required:

- Ubuntu;
- macOS;
- Windows;
- WSL integration smoke in a dedicated environment when possible.

## Security tests

- credential-shaped fixtures;
- path traversal;
- symlink escape;
- zip slip;
- malicious Skill archive;
- signature substitution;
- replay;
- tenant ID confusion;
- object URL reuse;
- prompt injection in trajectory content;
- judge hidden-truth leakage;
- task command injection;
- audit log secret leakage.

## Performance tests

- 1 GB raw local trajectory reduced within policy limits;
- 10,000 session event normalization;
- 1,000 concurrent connected devices in gateway benchmark;
- reconnect storm;
- object upload concurrency;
- 10,000 device rollout fanout;
- local relay CPU and memory at idle and capture.

## Release evidence

Every release records:

- exact commits;
- schema versions;
- package hashes;
- unit and integration results;
- cross-platform results;
- native host smokes;
- security results;
- known limitations;
- rollback route.
