# Dharma Agent Fabric plugin

**Your agents, learning together.**

Dharma Agent Fabric brings your organization's agents together to share knowledge, learn from real work and collaborate across devices, member accounts and AI providers. This plugin connects your AI agent client (Claude Code, Grok or another MCP-capable client) to your organization's Fabric control plane and adds a role-aware setup skill for onboarding team agents.

- Build a shared understanding of your business: the same vocabulary, project context and working methods for every agent, with clear roles and access.
- Turn experience into better skills: capture lessons from each agent's local work and share signed skill improvements across the organization.
- Connect local coding agents and managed agents in one organization, across model providers, subscriptions and machines, each with its own identity and role.

## What's included

| Component | Purpose |
| --- | --- |
| MCP server `dharma-agent-fabric` | Remote MCP server at `https://mcp.dharma-ai.io/mcp` (streamable HTTP, OAuth). Read your organization's identity, agents, devices, tasks, trajectories, failures, evaluations, skills and usage; with explicit confirmation, dispatch tasks and agent-to-agent messages, run analyses and evaluations, and stage, release, roll out or roll back skill remediations. |
| Skill `dharma-agent-fabric-setup` | Set up or recover an authorized Fabric client, establish its actual organization and assigned role, and connect qualified shared knowledge and role-bounded factory work. |
| Skill `dharma-agent-fabric` | Operate already-authorized trajectory, task, agent-to-agent, evaluation and signed-skill workflows after setup. Its operational source and nine references are shared with the Codex plugin. |

### Source parity

The authored operational skill is `plugins/dharma-agent-fabric/skills/dharma-agent-fabric`.
`npm run plugin:skills:generate` renders its ten enumerated files into this plugin;
it does not install anything. The setup skill remains a separate, unchanged tree.
`npm run plugin:skills:generate -- --dry-run` reports the exact proposed paths and
before/after hashes without creating directories or overwriting files.
`npm run plugin:skills:check` checks the complete file set, inline local reference
paths, LF-normalized SHA256 parity and independent route-version increments
against the Git baseline. Raw-byte equality is reported separately. Only these
twenty common-file paths receive the LF Git policy.
Manual publication checks require a nonzero immutable `GITHUB_SHA` matching the
checkout; this validates that selected payload, not its change since a prior release.
PR and push checks retain their separate base/before content-version comparison.

This source candidate is Claude/Grok `1.0.5`; Codex remains `0.1.0`. A later change
to shared content requires each affected route's own version increment, not
synchronized version numbers. A source change does not alter a previously
reviewed or submitted bundle. Publisher review, strict client validation,
installation and publication are separate and are not established by this check.
Static plugin content is not a signed organization skill bundle, activation,
authenticated task use or loaded-context rollback. Neither a file hash nor an
identifier echo proves those states.

## Install

### Claude Code

```
/plugin marketplace add dharma-ai-labs/dharma-agent-fabric
/plugin install dharma-agent-fabric@dharma-ai-labs
```

Then run `/mcp`, select `dharma-agent-fabric` and choose **Authenticate**. Sign in with your Dharma account in the browser and select your organization. The server uses standard MCP OAuth (dynamic client registration with PKCE), so no API key or client secret is needed.

### Grok CLI (Grok Build)

```
grok plugin marketplace add dharma-ai-labs/dharma-agent-fabric
grok plugin install dharma-agent-fabric --trust
```

`--trust` activates the plugin's MCP server and skill; omit it to review the source first. Then run `/mcps` in Grok, select `dharma-agent-fabric` and press `i` to authenticate. Sign in with your Dharma account in the browser and select your organization. `grok mcp doctor` reports `Auth required` until you complete this sign-in.

### Grok Bot and grok.com (custom connector)

Grok chat surfaces use the remote MCP server directly, without this plugin's setup skill. In Connectors, choose **New Connector** → **Custom**, enter `https://mcp.dharma-ai.io/mcp`, then authenticate with your Dharma account. On Business and Enterprise workspaces an administrator may need to provision the connector first.

### Find your organization ID

Fabric tools take your organization ID (`org_...`) as `organizationId`, and no tool lists the organizations you belong to. Copy the ID from your organization workspace at https://www.dharma-ai.io/portal; it is also part of the organization-specific login command shown in the dashboard (see the [customer guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)). Then ask: "Show my Dharma Agent Fabric identity for organization `org_...`." `fabric_get_identity` confirms your membership state for that organization.

## Try it

- "Show my Dharma Agent Fabric identity and organization context."
- "List the agents in my selected Dharma Agent Fabric organization."
- "List the enrolled Fabric devices visible to me in my selected organization."
- "Summarize the recent Fabric tasks in my selected organization."
- "List the Fabric skills available in my selected organization."

## Safety and permissions

- Every tool call runs as the signed-in Dharma member, limited to that member's organization membership and assigned role. The plugin grants no extra permissions.
- Evidence expansion, paid analysis, task dispatch, agent-to-agent messages, GitHub writes (including merging an approved skill-remediation pull request), skill release, rollout and rollback require explicit confirmation and are metered or gated by your organization's policy.
- The setup skill never handles passwords, keys, tokens or grants in chat, and treats installation, enrollment, delivery and observed use as separate, separately verified states.

## Data this plugin sends

- The plugin ships no executables, hooks or local telemetry. Both skills are instructions and references that your agent client reads locally; their presence alone does not transmit data.
- When you sign in, the Dharma authorization server (`clerk.dharma-ai.io`) receives the OAuth request, and your client receives an access token scoped to `openid`, `profile`, `email` and `user:org:read` for your Dharma account and organization.
- When your client calls a Fabric tool, the tool name and its arguments, such as an organization, agent, task or remediation identifier, a task or message you approved, or an analysis request, are sent over HTTPS to `https://mcp.dharma-ai.io/mcp`. The response contains only the organization data that your membership and role allow.
- Mutating, paid or GitHub-writing tools send data only after your explicit confirmation. Nothing else from your conversation, files or machine is sent by the plugin.
- Separately from the connector, the setup skill can guide your agent, with your approval, to install the official Dharma CLI from the npm registry (`npm install --global @dharma-ai-labs/agent-fabric`) and complete a browser sign-in at `www.dharma-ai.io`. The CLI then exchanges enrollment, task and skill data with Dharma's platform (`www.dharma-ai.io`, `api.dharma-ai.io`) under its own enrollment and your organization's policy.
- The operational skill describes approved local trajectory preview/sync, task dispatch and results, agent-to-agent messages, BYOK/managed billing checks, evaluation and signed-skill rollout/rollback. Invoking these workflows can send their scoped task/message text, filtered evidence, skill metadata and usage to the existing Fabric services under the relevant CLI/device or connector authority. Local provider credentials stay local; model execution and paid analysis have separate policy and cost gates. Adding this skill does not authorize collection, synchronization, dispatch or rollout. Route-specific directory disclosure answers require separate review before any new submission.
- How Dharma stores and retains this data is described in the [privacy policy](https://www.dharma-ai.io/privacy).

## Requirements

- A Dharma AI account with membership in an organization that has Agent Fabric enabled.
- Claude Code or the Grok CLI with plugin support, or any client that supports remote MCP servers with OAuth (for example Grok Bot or grok.com custom connectors).

## Support and policies

- Website: https://dharma-ai.io/
- Support: https://www.dharma-ai.io/docs/agent-fabric-support
- Privacy policy: https://www.dharma-ai.io/privacy
- Terms of service: https://dharma-ai.io/terms

Developed by Dharma AI Labs, Inc. Licensed under the MIT License.
