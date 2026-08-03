# Dharma Agent Fabric Design

**Date:** 2026-08-03  
**Status:** Approved build design  
**Audience:** Codex and implementing engineers

## Goal

Build a provider-independent local-to-cloud fabric that captures real coding-agent trajectories, lets Dharma send bounded tasks and messages to local agents, performs organization-wide evaluation and remediation, and automatically installs signed Skill improvements across the company.

## Chosen evidence policy

The system uses a combined deep and full-session model:

1. Complete raw provider evidence remains in an encrypted local vault.
2. The local relay performs substantial filtering, normalization, deduplication, compression, and first-pass evidence analysis.
3. The initial upload is a reduced full-session representation for authorized pilot workspaces.
4. The server may request exact additional spans for a named evaluation or remediation purpose.
5. Every expansion is re-authorized locally and produces a disclosure receipt.

The purpose of local processing is not to hide most useful content. It is to prevent gigabyte-scale uploads, remove credentials and unrelated data, and preserve the high-information evidence required for server analysis.

## Product surfaces

### Public local product

- open-source CLI;
- user-level relay daemon;
- provider adapters;
- encrypted local vault;
- evidence reduction;
- task runner;
- A2A client;
- Skill installer and rollback;
- public Codex Skill and plugin metadata.

### Private Dharma platform

- device and workspace registry;
- relay gateway;
- trajectory ingestion;
- task and message broker;
- organization orchestrator;
- deterministic evaluators;
- judge and rubric authoring;
- Failure Atlas;
- remediation engine;
- GitHub App;
- Skill release and rollout;
- managed environments;
- billing and audit;
- MCP app.

## Main architecture decision

Use Better Harness as the source of provider evidence adapters and evidence-bound workflow patterns. Do not extend its local report engine into the organization control plane. Wrap and adapt its public capabilities behind Dharma interfaces.

## Repository decision

Use a public `dharma-agent-fabric` repository and a private control-plane repository. Share versioned JSON Schemas and a released TypeScript contracts package.

## Local trust boundary

The relay is the final local authority. It verifies every server task, evidence request, message, and Skill release against:

- server signature;
- organization;
- device;
- workspace;
- provider capability;
- policy revision;
- expiry;
- replay protection;
- command and path authority;
- network authority;
- cost and concurrency limits.

The server never receives arbitrary inbound access to localhost.

## Device identity

Use OAuth device authorization plus a local Ed25519 keypair. Store the private key in the operating-system keychain. Sign protocol envelopes at the application layer in addition to TLS.

## Evidence model

The canonical uploaded unit is a revisioned `TrajectoryCapsule` containing:

- provider and workspace identity;
- task and Skill state;
- normalized event graph;
- selected messages, tool results, code, diffs, and validation evidence;
- local content references;
- redaction and omission receipt;
- coverage state;
- content hashes;
- additional evidence available locally.

## Task model

Tasks are signed `TaskEnvelope` messages. The relay executes them in isolated Git worktrees through provider-specific adapters. Default authority permits a task branch but not default-branch merge or deployment.

## A2A model

Local and managed agents use one `AgentMessage` contract containing prose, structured workflow state, evidence references, authority, and delivery expiry.

## Skill source model

Each customer has one private GitHub control repository. Each Skill has one mutable authoring branch. Reviewed exact commits are assembled into immutable signed bundles. Local agents install bundles, not branch heads.

## Skill rollout model

- automatic staging;
- signature and hash verification;
- provider-specific discovery test;
- atomic activation;
- next-session behavior when required by the host;
- canary rollout;
- installation receipts;
- automatic rollback on health failure.

Low-risk Skill changes can promote automatically after held-out and canary gates. New write, network, secret, merge, deployment, or destructive authority requires explicit approval.

## Evaluation model

Prefer deterministic verifiers. Invoke LLM judges only for semantic questions. Record model, prompt, inputs, outputs, usage, cost, and confidence.

Custom rubrics and contracts are proposals, not automatically authoritative. Use the names:

- rubric authoring service;
- integrity-contract proposal generator;
- policy and Skill remediation engine.

## Remediation model

The remediation loop is:

```text
real trajectories
  -> failure family
  -> cause attribution
  -> candidate Skill or policy change
  -> GitHub PR
  -> historical replay
  -> held-out validation
  -> signed release
  -> canary installation
  -> organization rollout
  -> post-rollout outcome window
  -> retain, revise, or roll back
```

## Billing model

### BYOK and local

The customer pays its provider directly. Dharma charges no model tokens for local agent execution. Dharma charges platform fees and Analysis Tokens only for Dharma-hosted semantic analysis or model work.

### Managed

Dharma charges Environment Tokens for managed agent and evaluation execution, plus any separated Analysis Token use.

## OpenAI distribution

Publish a Codex plugin containing the Skill and connect it to a remote MCP-backed Dharma app. The MCP app exposes organization-level intent tools, not arbitrary shell or local file primitives.

## Error handling

- Missing evidence remains explicit.
- Offline capture continues.
- Uploads use durable cursors and idempotency.
- Task leases expire safely.
- Skill activation retains the last known-good bundle.
- Unsupported provider capability is reported, not inferred.
- Cost caps block or require approval.
- Cross-tenant and signature failures fail closed.

## Testing strategy

- deterministic fixtures;
- provider-positive and negative workspace tests;
- secret-leakage tests;
- Windows and POSIX path tests;
- protocol replay and expiry tests;
- worktree escape tests;
- tenant isolation tests;
- signed Skill rollout and rollback tests;
- native Codex and Claude smokes;
- end-to-end pilot workflow.

## First vertical slice

The first reviewable release captures a workspace-qualified Codex or Claude session, stores raw evidence in the encrypted local vault, emits a schema-valid reduced capsule, and proves no fixture secret or foreign-workspace event entered the capsule. It performs no network operation.

## Final design boundary

The first production product is a controlled organization improvement loop, not a universal compiler, general endpoint manager, or autonomous deployment system.
