---
name: dharma-agent-fabric
description: Use when connecting a repository or local coding agent to Dharma, inspecting trajectory synchronization, dispatching or receiving organization tasks, communicating with another agent, requesting evaluations, reviewing failure families, applying signed Skill releases, or rolling back a Skill bundle.
---

# Dharma Agent Fabric

Connect local coding agents to Dharma's organization-wide evaluation, task, communication, and Skill-remediation loop.

## Operating boundary

The local `dharma` CLI and relay own device, workspace, local evidence, provider invocation, and Skill installation. The remote Dharma app owns organization data and authorized control-plane actions. Never substitute a remote app action for local authority.

The relay initiates every network connection. Do not expose an inbound localhost server or accept arbitrary shell commands.

## Step 1: Resolve local and remote capability

From the target repository, run:

```text
dharma status --json
dharma providers list --workspace . --json
dharma skills status --workspace . --json
```

If the CLI is missing, follow [Installation and enrollment](references/installation.md).

If the remote app is unavailable, local capture, preview, Skill status, and previously authorized tasks may still work. Do not claim an organization action succeeded without a remote receipt.

## Step 2: Choose the workflow

- Connect or register a repository: [Installation and enrollment](references/installation.md)
- Inspect or synchronize trajectories: [Trajectory synchronization](references/trajectory-sync.md)
- Dispatch, inspect, or respond to a task: [Task orchestration](references/task-orchestration.md)
- Communicate with another agent: [Agent-to-agent communication](references/a2a.md)
- Ask the organization control agent to inspect or propose work: [Organization control agent](references/control-agent.md)
- Request evaluation or remediation: [Evaluation and remediation](references/evaluation-remediation.md)
- Inspect, install, release, or roll back Skills: [Skill releases](references/skill-releases.md)
- Explain managed versus BYOK cost: [BYOK and billing](references/byok-billing.md)
- Review authority and privacy: [Security and authority](references/security-authority.md)

## Step 3: Preserve exact scope

Always resolve:

- organization;
- device;
- workspace;
- provider;
- evidence mode;
- task or conversation identity;
- pinned Skill bundle;
- read, write, command, network, Git, and cost authority;
- required confirmation;
- expected receipt.

Do not widen from one repository to every repository, one provider to every provider, or project scope to user-home scope without explicit authorization.

## Step 4: Use local evidence honestly

A configured Skill, rule, hook, MCP server, or plugin proves presence, not use. A transcript proves observed behavior only for its admitted workspace and time range. Missing evidence stays `partial`, `unavailable`, `excluded`, or `redacted`; it never becomes a clean score.

## Step 5: Treat model-generated changes as proposals

A rubric, integrity contract, Skill edit, or remediation becomes authoritative only after its required deterministic checks, held-out evaluation, release authority, signature, installation verification, and rollout gate pass.

Do not describe the system as an integrity-contract compiler. Use `rubric proposal`, `contract proposal`, or `Skill remediation` according to the actual operation.

## Step 6: Verify every write

For a remote action, return:

- target organization and workspace;
- action and authority class;
- estimated Dharma cost;
- confirmation state;
- audit or operation ID;
- current status;
- expected completion or next evidence.

For local Skill installation, require the bundle ID, source commits, hashes, signature, activation mode, checks, and installation receipt.

## Step 7: Never expose forbidden primitives

Do not offer or simulate:

- arbitrary remote shell;
- arbitrary local file read;
- unrestricted user-home upload;
- generic merge or deployment;
- secret retrieval;
- mutable branch-head installation;
- hidden-truth access by an evaluated agent.

Finish with the smallest verified next action and the exact receipt or blocker.
