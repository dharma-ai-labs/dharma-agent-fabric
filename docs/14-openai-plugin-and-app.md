# OpenAI Plugin and App Distribution

## Current platform model

As of 2026-08-03, OpenAI describes plugins as the primary discovery unit for workflow capability in ChatGPT and Codex. A plugin may contain Skills, apps, and app templates. Apps remain the integration boundary for external data and actions, and app permissions continue to govern read, write, confirmation, and source-system access.

Official references:

- https://help.openai.com/en/articles/20001256-plugins-in-codex/
- https://help.openai.com/en/articles/11487775-apps-in-chatgpt
- https://help.openai.com/en/articles/12584461

OpenAI recommends the Apps SDK for app experiences, including MCP-backed tools. Public app-directory submission is possible, while managed workspaces can publish custom MCP apps under administrator controls.

## Distribution architecture

Publish one Dharma Agent Fabric plugin with:

1. A public Skill usable in Codex.
2. A remote Dharma app backed by MCP tools.
3. An organization-configurable app template when the current OpenAI schema supports it.

The Skill provides workflow guidance. The app provides authenticated organization data and actions. The local relay is never directly exposed to ChatGPT or Codex.

## Public Codex Skill

The included Skill supports:

- connecting a device;
- registering a workspace;
- inspecting provider capabilities;
- previewing and synchronizing trajectories;
- inspecting pending remote tasks;
- requesting evaluations;
- reviewing failure families;
- proposing remediations;
- inspecting Skill releases;
- rolling back a local Skill bundle;
- sending organization agent messages;
- explaining BYOK and managed cost boundaries.

## Plugin manifest scaffold

The package includes `.codex-plugin/plugin.json` using the current public pattern demonstrated by Better Harness. Before publication, validate it with the installed Codex version and current OpenAI documentation. Do not assume a manifest field exists because an older plugin used it.

## Remote MCP app

### Read tools

- `list_organizations`
- `list_devices`
- `list_agents`
- `list_workspaces`
- `get_agent_status`
- `get_trajectory_summary`
- `get_evaluation`
- `list_failure_families`
- `get_remediation`
- `get_skill_release`
- `get_rollout_status`
- `get_usage`
- `estimate_cost`

### Write tools

- `request_additional_evidence`
- `create_evaluation`
- `dispatch_task`
- `send_agent_message`
- `cancel_task`
- `propose_remediation`
- `create_skill_release`
- `rollout_skill_release`
- `rollback_skill_release`

### Forbidden tools

Do not expose:

- arbitrary shell execution;
- arbitrary local file reads;
- unbounded transcript upload;
- generic branch merge;
- generic deployment;
- unrestricted secret access;
- role or authority mutation without a dedicated reviewed workflow.

## OAuth scopes

Suggested application scopes:

```text
agent_fabric.org.read
agent_fabric.devices.read
agent_fabric.devices.manage
agent_fabric.workspaces.read
agent_fabric.trajectories.read
agent_fabric.evidence.request
agent_fabric.tasks.read
agent_fabric.tasks.create
agent_fabric.tasks.cancel
agent_fabric.messages.send
agent_fabric.evals.read
agent_fabric.evals.create
agent_fabric.remediations.read
agent_fabric.remediations.propose
agent_fabric.skills.read
agent_fabric.skills.release
agent_fabric.skills.rollback
agent_fabric.billing.read
```

The app must not grant more than the source Dharma organization membership permits.

## Action confirmations

OpenAI app permissions and the Dharma source system both apply.

Require an explicit preview before:

- evidence expansion;
- task dispatch;
- semantic evaluation with a cost;
- remediation proposal that writes GitHub;
- Skill release;
- rollout expansion;
- rollback.

The preview shows target organization, workspace, provider, authority, evidence depth, cost cap, and expected effect.

## MCP implementation

Recommended stack:

- TypeScript;
- stateless MCP server;
- OAuth to Dharma;
- exact organization API client;
- idempotency keys for writes;
- tool-level input and output schemas;
- audit correlation ID returned from every write;
- no relay credentials or local device keys in the app.

## Publication sequence

1. Publish the Skill-only plugin internally.
2. Validate Codex discovery and invocation.
3. Deploy the MCP app in developer mode.
4. Connect a test Dharma organization.
5. Exercise read-only tools.
6. Exercise low-risk writes with confirmations.
7. Complete security and privacy review.
8. Publish the custom app to the Dharma workspace.
9. Package the Skill and app into the plugin model supported at submission time.
10. Submit the public app or plugin with reviewer credentials and a test organization.

## Public listing claims

Safe initial description:

> Connect local coding agents to organization-wide evaluation, remote task orchestration, agent communication, and signed Skill updates while keeping provider credentials local.

Do not claim:

- universal host support;
- zero-touch setup;
- arbitrary autonomous code deployment;
- complete secret elimination;
- guaranteed improvement from every remediation;
- production repair when only staged evidence exists.
