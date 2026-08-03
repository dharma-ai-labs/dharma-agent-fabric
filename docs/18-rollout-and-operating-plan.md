# Rollout and Operating Plan

## Phase 0: Foundation

**Deliverable:** public repository structure, upstream boundary, schemas, contract package, CI, license notices.

Acceptance:

- schemas validate;
- TypeScript contracts match;
- Better Harness upstream tests pass;
- package and license verification passes;
- no server or provider claim yet.

## Phase 1: Local evidence core

**Deliverable:** local vault, policy, filtering, provider evidence adapters, reduced capsule generation.

Initial hosts:

- Codex
- Claude Code

Acceptance:

- one real or representative session per host;
- workspace-positive and negative binding;
- secret fixture removed;
- capsule validates;
- no network required;
- Windows, macOS, and Linux tests.

## Phase 2: Relay and ingestion

**Deliverable:** enrollment, outbound connection, resumable upload, server ingestion, evidence expansion.

Acceptance:

- disconnect and resume;
- no duplicate capsule;
- device revocation;
- expanded evidence receipt;
- tenant isolation;
- upload budget enforcement.

## Phase 3: Skill supply chain

**Deliverable:** customer GitHub control repo, skill branch contract, bundle build, signatures, installer, receipts, rollback.

Acceptance:

- one Skill branch;
- reviewed PR;
- deterministic bundle;
- Codex and Claude installation;
- canary failure and rollback;
- running task pinning.

## Phase 4: Remote task and A2A fabric

**Deliverable:** device capability registry, task broker, worktree runner, provider task adapters, A2A messages.

Acceptance:

- server-initiated Codex task;
- server-initiated Claude task;
- no default-branch merge;
- cancellation and lease expiry;
- managed-to-local and local-to-managed message;
- offline delivery.

## Phase 5: Evaluation and remediation

**Deliverable:** deterministic evals, semantic judge, rubric proposals, Failure Atlas, remediation PR, held-out validation.

Acceptance:

- at least 100 real pilot trajectories;
- one repeated failure family;
- one Skill remediation;
- historical and held-out result;
- signed release candidate;
- customer remediation package.

## Phase 6: Organization rollout and outcomes

**Deliverable:** canary and staged rollout, health checks, post-rollout analysis, automatic rollback.

Acceptance:

- 90% of online targets installed in one hour;
- activation verified;
- forced rollback succeeds;
- later outcome window compared;
- no-improvement result handled honestly.

## Phase 7: Managed runtime and billing

**Deliverable:** managed worker, BYOK path, usage metering, cost estimates, hard caps.

Acceptance:

- local BYOK task creates no Dharma model charge;
- server judge creates exact Analysis Token event;
- managed task creates Environment Token event;
- hard cap blocks or requires approval;
- cost report reconciles.

## Phase 8: OpenAI plugin and app

**Deliverable:** public Skill plugin, MCP app, OAuth, read and write tools, confirmation UX, submission package.

Acceptance:

- Codex discovers the Skill;
- test user authenticates app;
- read tools preserve source permissions;
- task dispatch and Skill rollout show confirmation;
- no forbidden generic shell or file tool;
- security and privacy documents complete.

## Pilot operating cadence

### Daily

- connection and upload health;
- secret-filter alerts;
- stuck tasks;
- rollout health;
- cost cap alerts;
- severe failure review.

### Weekly

- provider coverage;
- failure-family review;
- remediation backlog;
- Skill branch review;
- judge cost and quality;
- customer evidence boundary;
- user feedback.

### Per remediation

- causal theory;
- risk class;
- historical and held-out evidence;
- release authority;
- canary result;
- post-rollout window;
- retain, revise, or rollback decision.

## Staffing assumptions

Initial build:

- one lead platform engineer;
- one local/CLI and provider-adapter engineer;
- one backend/eval engineer;
- part-time security review;
- founder product and customer workflow ownership.

## Launch constraints

Do not expand to more hosts before Codex and Claude complete the full evidence-task-skill loop. Do not build broad dashboards before the remediation cycle works end to end. Do not add autonomous merge or deployment merely to demonstrate control-plane breadth.
