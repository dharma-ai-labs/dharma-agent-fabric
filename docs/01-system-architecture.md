# System Architecture

## Architectural thesis

Dharma Agent Fabric is a federated control plane. Raw evidence and provider credentials remain local. Organization policy, evaluation, orchestration, skill source, and cross-team learning live in the remote control plane. The two sides communicate through signed, typed, auditable envelopes over an outbound-only connection.

## Context diagram

```mermaid
flowchart TB
  subgraph Device[Developer machine]
    Providers[Codex / Claude / Cursor / Qoder / Qwen / Copilot / Pi / WorkBuddy]
    Relay[Dharma Local Relay]
    Vault[Encrypted Local Evidence Vault]
    TaskRunner[Worktree Task Runner]
    SkillManager[Skill Manager]
    Providers --> Relay
    Relay <--> Vault
    Relay <--> TaskRunner
    Relay <--> SkillManager
  end

  subgraph Dharma[Dharma cloud]
    Gateway[Relay Gateway]
    Registry[Device, Agent, Workspace Registry]
    Ingest[Trajectory Ingestion]
    Orchestrator[Organization Orchestrator]
    Broker[Task and A2A Broker]
    Eval[Deterministic Evals and Judge Service]
    Atlas[Failure Atlas]
    Remediation[Policy and Skill Remediation Engine]
    Release[Skill Release Service]
    Billing[Usage and Billing]
    Audit[Audit and Receipts]
  end

  subgraph GitHub[Customer skill control repository]
    Branches[One authoring branch per skill]
    Main[Release manifests and tags]
  end

  subgraph Managed[Dharma managed environments]
    ManagedAgents[Managed coding and evaluation agents]
  end

  Relay <-->|WSS / HTTPS, outbound initiated| Gateway
  Gateway <--> Registry
  Gateway <--> Ingest
  Gateway <--> Broker
  Orchestrator <--> Broker
  Orchestrator <--> Eval
  Eval <--> Atlas
  Atlas <--> Remediation
  Remediation <--> Branches
  Release <--> Branches
  Release <--> Main
  Release --> Gateway
  Orchestrator <--> ManagedAgents
  Eval <--> ManagedAgents
  Billing <--> Gateway
  Billing <--> Eval
  Audit <--> Gateway
  Audit <--> Release
```

## Principal components

### 1. Provider adapters

Each provider is represented by independent support slices:

- source discovery;
- workspace binding;
- configured asset inventory;
- session evidence parsing;
- task execution;
- session continuation;
- skill installation target;
- activation behavior;
- usage evidence;
- cancellation and recovery.

A provider may support some slices and not others. The capability registry reports the exact state.

### 2. Local relay

The relay is a durable user-level daemon and CLI. It owns:

- device identity;
- workspace registration;
- local policy enforcement;
- trajectory collection;
- local vault and spool;
- evidence reduction;
- outbound session management;
- task execution and worktrees;
- A2A delivery;
- skill installation and rollback;
- receipts and local diagnostics.

### 3. Local evidence vault

The vault is not a plain transcript directory. It is a content-addressed evidence store with:

- encrypted blobs;
- SQLite metadata;
- source locators;
- workspace and provider binding;
- content hashes;
- retention policy;
- disclosure history;
- task and skill version lineage.

### 4. Relay gateway

The gateway terminates device connections, authenticates application-level signatures, routes messages, assigns resumable cursors, and never assumes that a connected device is authorized for every workspace or action.

### 5. Trajectory ingestion

Ingestion validates schemas, organization identity, workspace registration, retention policy, redaction receipts, content hashes, and upload limits. It stores structured metadata in Postgres and encrypted chunks in object storage.

### 6. Organization orchestrator

The orchestrator decides which local or managed agent should perform a task. It uses:

- task requirements;
- provider capability;
- workspace access;
- device presence;
- skill versions;
- budget;
- concurrency;
- authority policy;
- failure and retry history.

It does not bypass local relay policy.

### 7. Evaluation plane

The evaluation plane contains:

- deterministic evaluators;
- trace and state validators;
- rubric authoring service;
- semantic judge service;
- paired experiment runner;
- hidden-truth store;
- historical replay;
- held-out evaluation;
- regression analysis;
- cost and confidence accounting.

### 8. Failure Atlas and remediation

The client-specific Failure Atlas stores verified failure-remediation-recovery pairs with applicability boundaries. The remediation engine creates candidate changes to:

- Skills;
- rules;
- prompts;
- hooks;
- validation commands;
- policy configuration;
- task-routing logic;
- evidence collection configuration.

It never grants itself release authority.

### 9. Skill release service

The release service turns reviewed skill branch commits into signed immutable bundles, targets them to devices and providers, tracks canaries, verifies activation, and issues rollback instructions.

### 10. Managed environments

Managed environments execute tasks and judges when:

- no compatible local worker is online;
- the customer chooses Dharma-hosted execution;
- held-out evaluation needs an isolated clean environment;
- a task must run outside employee devices.

Managed and local agents use the same task, message, evidence, and skill contracts.

## Trust boundaries

```mermaid
flowchart LR
  User[Developer or operator]
  Local[Local relay and vault]
  Cloud[Dharma control plane]
  GitHub[GitHub App and skill repo]
  Provider[Local provider authentication]
  Model[Managed or BYOK model endpoint]

  User -->|local consent and commands| Local
  Local -->|signed reduced evidence| Cloud
  Cloud -->|signed bounded tasks and releases| Local
  Local -->|native host invocation| Provider
  Cloud -->|reviewed PR and release| GitHub
  Cloud -->|judge request| Model

  classDef boundary fill:#f5f5f5,stroke:#333,stroke-width:1px;
  class Local,Cloud,GitHub,Provider,Model boundary;
```

### Boundary rules

- The cloud cannot read arbitrary local files.
- The local relay cannot claim a server release without verifying a Dharma signature.
- The GitHub App cannot cause local installation until a signed release exists.
- The orchestrator cannot make a device exceed its local authority policy.
- Local provider credentials never leave the device in BYOK mode.
- A judge cannot access hidden truth before the evaluated output is frozen.
- A remediation producer cannot approve its own high-risk release.

## Data flow: adaptive deep sync

```mermaid
sequenceDiagram
  participant P as Local provider
  participant R as Relay
  participant V as Local vault
  participant S as Dharma server
  participant J as Judge

  P->>R: New or changed session evidence
  R->>V: Preserve raw evidence and hashes
  R->>R: Qualify workspace, redact, dedupe, normalize, compress
  R->>S: TrajectoryCapsule + selected content
  S->>S: Deterministic analysis
  alt More evidence required
    S->>R: Signed EvidenceRequest
    R->>R: Re-authorize and filter exact spans
    R->>S: EvidenceResponse + disclosure receipt
  end
  alt Semantic judgment required
    S->>J: Bounded judge request
    J-->>S: Judgment + usage + confidence
  end
  S-->>R: Ack and durable cursor
```

## Data flow: skill remediation

```mermaid
sequenceDiagram
  participant A as Failure Atlas
  participant E as Eval service
  participant G as GitHub App
  participant R as Release service
  participant L as Local relays

  A->>E: Repeated failure family
  E->>G: Create remediation PR on skill branch
  G-->>E: Reviewed candidate commit
  E->>E: Historical and held-out validation
  E->>R: Promotion candidate and evidence receipt
  R->>G: Create signed bundle from exact commits
  R->>L: Canary SkillReleaseAvailable
  L-->>R: Installation and activation receipts
  alt Canary healthy
    R->>L: Expand rollout
  else Canary unhealthy
    R->>L: Rollback release
  end
```

## Deployment topology

### Initial deployment

- Control plane APIs: existing Dharma Next.js or Fastify service behind the organization boundary.
- Relay gateway: dedicated WebSocket service.
- Database: PostgreSQL.
- Queue and presence: Redis Streams or BullMQ for v1.
- Object storage: GCS with organization-scoped prefixes and KMS.
- GitHub integration: GitHub App.
- Evaluation workers: Cloud Run jobs or managed worker pool.
- Managed agent runners: isolated ephemeral containers.
- MCP app: separate stateless service calling the control plane.

### Scale transition

Move the relay gateway and high-concurrency workers to Kubernetes or another environment designed for long-lived connections when concurrent device count or connection lifetime exceeds the managed serverless boundary. Preserve protocol compatibility.

## Availability model

The system must continue safely during partial failure:

- Local capture continues while offline.
- Uploads resume from durable cursors.
- Tasks remain leased and idempotent.
- Skill installation never depends on an unverified partial download.
- Devices retain the last known-good skill bundle.
- The server records evidence as partial rather than silently treating absent data as healthy.
