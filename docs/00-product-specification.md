# Product Specification

## Product name

**Dharma Agent Fabric**

## One-line definition

Dharma Agent Fabric connects a company's local coding agents to an organization-wide evaluation, orchestration, remediation, and signed skill-release system without replacing the developers' preferred providers.

## Customer problem

Companies increasingly use multiple coding agents across many repositories, machines, and teams. The agents act locally, but the organization lacks a reliable system to:

- observe the actual trajectories that produced changes;
- distinguish agent failure from handoff, environment, tool, test, or process failure;
- find repeated failure families across a company;
- send a task or follow-up message to the right local or managed agent;
- improve shared instructions and skills from observed evidence;
- prove that a remediation works on historical and held-out cases;
- distribute the approved improvement to every affected local agent;
- know which machines installed it and whether behavior improved afterward;
- preserve local-provider choice and customer-supplied credentials;
- pay Dharma only for the analysis and managed execution Dharma actually performs.

A final diff or trace dashboard does not solve this. The organization needs a closed operational loop from local trajectory to verified skill remediation and back to every relevant agent.

## Initial customer

The first target is an AI-native or AI-forward software company with:

- 5 to 100 engineers;
- at least two coding-agent providers in active use;
- multiple repositories or workspaces;
- repeated local agent failures or inconsistent delivery practices;
- no desire to centralize every agent interaction in one hosted provider;
- a technical leader willing to authorize organization-wide trajectory analysis and skill rollout.

## Primary buyer and users

| Role | Job to be done |
| --- | --- |
| CTO or Head of AI | Govern agent behavior across teams without replacing local tools. |
| Platform or Agent Engineering Lead | Connect providers, define policy, dispatch tasks, inspect failures, and manage skill releases. |
| Engineering Manager | See repeated workflow problems and verified remediation progress. |
| Developer | Keep using a preferred local coding agent while receiving approved company skills and tasks. |
| Eval owner | Build organization-specific rubrics and held-out tests from real trajectories. |
| Security or compliance owner | Control what leaves devices, who may dispatch tasks, and which actions require approval. |

## Core user journeys

### 1. Connect a local agent

1. A developer installs the open-source CLI or Codex plugin.
2. The CLI authenticates the user and enrolls the device.
3. The developer registers one repository or workspace.
4. The relay detects supported local agent providers.
5. The user sees the exact evidence, task, and skill capabilities available for each provider.
6. The relay establishes an outbound connection to Dharma.

### 2. Capture and synchronize trajectories

1. A local provider creates or updates a session.
2. The relay binds the session to a registered workspace.
3. Raw evidence is copied or indexed into the encrypted local vault.
4. The relay removes secrets, excluded paths, binaries, caches, and irrelevant duplication.
5. It creates a normalized event graph and reduced full-session capsule.
6. The capsule is encrypted and uploaded.
7. The server may request additional exact spans for a named evaluation purpose.
8. The relay applies policy again and records the disclosure receipt.

### 3. Dispatch a task to a local agent

1. An authorized operator or orchestrator creates a task.
2. The server selects a compatible online device, workspace, and provider.
3. A signed task envelope reaches the relay over the existing outbound channel.
4. The relay verifies identity, expiry, replay protection, workspace policy, provider capability, command allowlist, and budget.
5. The relay creates a Git worktree and pinned skill environment.
6. The local provider executes with the developer's existing provider authentication.
7. The relay streams normalized progress and evidence.
8. The task commits and pushes only a task branch unless additional release authority exists.

### 4. Communicate between agents

1. A local or managed agent emits a structured request, state transition, or question.
2. The A2A broker routes it to another local or managed agent.
3. The receiving agent gets prose plus structured evidence, authority, and recovery state.
4. Responses preserve conversation, task, and evidence lineage.
5. If the target is offline, the message remains leased and resumable.

### 5. Remediate a repeated failure

1. Server analysis clusters related trajectories.
2. Deterministic evaluators measure the known contract and failure conditions.
3. An LLM judge is invoked only when semantic analysis is necessary.
4. The rubric authoring service proposes organization-specific criteria.
5. The remediation engine proposes a change to one or more skills, policies, prompts, hooks, or validation commands.
6. The change lands in the applicable organization skill branch through a GitHub pull request.
7. Historical and held-out evaluations run.
8. A signed bundle is released according to risk policy.
9. Canary relays install and verify it.
10. The bundle automatically expands or rolls back.
11. Later trajectories determine whether the failure rate, recovery time, human burden, or business outcome improved.

## Business value

The buyer is not purchasing a transcript warehouse. The buyer receives:

- lower repeated agent failure;
- faster recovery from coding-agent mistakes;
- less engineering time spent reconstructing agent behavior;
- reusable company practices that reach every provider;
- controlled remote execution without exposing inbound machine access;
- consistent skills and release gates across repositories;
- measurable before-and-after evidence;
- optional managed environments when no local worker is available;
- BYOK economics when the customer's local provider handles model execution.

## Functional requirements

### Local relay

- Install as a user-level service on Windows, WSL2, macOS, and Linux.
- Detect and report provider support independently for evidence, task execution, session continuation, skills, and activation.
- Watch supported trajectory sources without requiring the provider to call Dharma.
- Maintain an encrypted local vault and durable upload spool.
- Support manual pause, per-workspace disable, and complete device revocation.
- Never accept arbitrary inbound network connections.

### Evidence

- Preserve raw local data and immutable content hashes.
- Produce normalized provider-independent events.
- Bind every session to the exact registered workspace.
- Remove secrets before any network transfer.
- Support reduced full-session upload and server-requested expansion.
- Track every redaction, omission, unsupported field, and expansion receipt.
- Keep static configured assets separate from observed runtime behavior.

### Remote tasks

- Use signed typed envelopes and default-deny authority.
- Isolate mutation in Git worktrees.
- Restrict commands, write paths, network, duration, concurrency, and branch behavior.
- Stream task state without uploading unbounded logs.
- Support cancel, pause, retry, lease expiry, device disconnect, and resumable completion.
- Never merge or deploy by default.

### Skills

- Keep one customer control repository and one authoring branch per skill.
- Build immutable bundles from exact commits.
- Sign and publish bundles through Dharma.
- Install automatically to the correct host locations.
- Pin active tasks to their starting bundle.
- Verify discovery or activation before success.
- Return installation receipts and roll back automatically on failure.

### Evaluation and remediation

- Prefer deterministic verifiers for mechanically testable requirements.
- Keep hidden truth outside the agent context.
- Support same-model direct-versus-stateful comparison.
- Record judge model, prompt version, inputs, outputs, cost, and confidence.
- Generate candidate rubrics and skill remediations, not automatically authoritative policy.
- Require historical, matched, held-out, regression, release, and post-release evidence appropriate to the risk class.
- Produce a customer-facing remediation package.

### Billing

- Meter Dharma-managed model and environment use.
- Do not charge model tokens for local BYOK provider execution.
- Meter server-side judge, rubric, clustering, remediation, and synthetic generation calls.
- Enforce per-task, per-device, per-workspace, and per-organization hard caps.
- Record estimated and actual cost by purpose.

## Success criteria for the first paid pilot

The pilot is successful when:

1. At least five developers connect two different agent providers across three repositories.
2. At least 100 real workspace-qualified trajectories are collected with no confirmed secret leakage.
3. At least one repeated failure family is identified with evidence from more than one developer or repository.
4. Dharma proposes one organization skill remediation.
5. The remediation passes a held-out gate and canary installation.
6. At least 90% of targeted online devices install the bundle automatically within one hour.
7. No active task changes skill version mid-run.
8. Rollback succeeds in a forced-failure test.
9. One server-initiated task completes on a local Codex or Claude worker through an isolated branch.
10. A later trajectory window demonstrates either reduced recurrence, reduced time-to-recovery, reduced manual correction, or an explicit no-improvement result.

## Non-goals for v1

- General endpoint management.
- Remote desktop or unrestricted shell access.
- Full device file indexing.
- Replacing GitHub, CI/CD, observability platforms, or coding-agent providers.
- Autonomous merge or deployment by default.
- Cross-customer learning without explicit contractual authorization.
- Claiming that every skill update improves outcomes.
- Reconstructing hidden model chain-of-thought.
- Automatic authoritative policy generation from prose alone.
- Supporting every IDE or agent host before its native contracts are verified.
