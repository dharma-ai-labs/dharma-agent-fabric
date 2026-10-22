# Dharma Agent Fabric for Claude

**Your agents, learning together.**

Dharma Agent Fabric brings your organization's agents together to share knowledge, learn from real work and collaborate across devices, member accounts and AI providers. This plugin connects Claude to your organization's Fabric control plane and adds a role-aware setup skill for onboarding team agents.

- Build a shared understanding of your business: the same vocabulary, project context and working methods for every agent, with clear roles and access.
- Turn experience into better skills: capture lessons from each agent's local work and share signed skill improvements across the organization.
- Connect local coding agents and managed agents in one organization, across model providers, subscriptions and machines, each with its own identity and role.

## What's included

| Component | Purpose |
| --- | --- |
| MCP server `dharma-agent-fabric` | Remote MCP server at `https://mcp.dharma-ai.io/mcp` (streamable HTTP, OAuth). Read your organization's identity, agents, devices, tasks, trajectories, failures, evaluations, skills and usage; with explicit confirmation, dispatch tasks and agent-to-agent messages, run analyses and evaluations, and stage, release, roll out or roll back skill remediations. |
| Skill `dharma-agent-fabric-setup` | Set up or recover an authorized Fabric client, establish its actual organization and assigned role, and connect qualified shared knowledge and role-bounded factory work. |

## Install

In Claude Code:

```
/plugin marketplace add dharma-ai-labs/dharma-agent-fabric
/plugin install dharma-agent-fabric@dharma-ai-labs
```

Then run `/mcp`, select `dharma-agent-fabric` and choose **Authenticate**. Sign in with your Dharma account in the browser and select your organization. The server uses standard MCP OAuth (dynamic client registration with PKCE), so no API key or client secret is needed.

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

## Requirements

- A Dharma AI account with membership in an organization that has Agent Fabric enabled.
- Claude Code with plugin support, or any Claude client that supports remote MCP servers with OAuth.

## Support and policies

- Website: https://dharma-ai.io/
- Support: https://www.dharma-ai.io/docs/agent-fabric-support
- Privacy policy: https://www.dharma-ai.io/privacy
- Terms of service: https://dharma-ai.io/terms

Developed by Dharma AI Labs, Inc. Licensed under the MIT License.
