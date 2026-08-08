# Dharma Agent Fabric

Dharma Agent Fabric connects local coding agents to an organization-scoped
evaluation, remediation, task-orchestration, and signed Skill release system.

The public edge keeps complete raw trajectories in an encrypted local vault.
Only workspace-qualified, policy-filtered trajectory capsules leave the device.
Every connection is outbound initiated; the server never receives an arbitrary
localhost shell or unrestricted file interface.

## Initial host support

| Host | Evidence | Remote task | Continuation | Skill install | Activation |
| --- | --- | --- | --- | --- | --- |
| Codex CLI/Desktop | available | available when installed | unavailable | available when installed | next session |
| Claude Code | available | available when installed | unavailable | available when installed | next session |
| Agy 1.0.1 | partial | read-only partial | partial | available when installed | next session |
| Other Better Harness hosts | evidence adapter work | unavailable | unavailable | unavailable | unavailable |

Each capability is verified independently. Evidence discovery does not imply
that task execution, continuation, or Skill activation works for that host.

## Customer onboarding

An organization starts in the Dharma dashboard after a paid offer or an
explicit sponsored canary entitlement is recorded. The dashboard provisions
the private remediation repository and selected runtime, then provides one
organization-scoped command:

```bash
npx @dharma-ai-labs/agent-fabric@0.1.0 onboard \
  --hq-url https://www.dharma-ai.io \
  --organization-id <organization-id> \
  --policy-revision <dashboard-policy-revision> \
  --workspace "$PWD"
```

The command opens browser approval against the customer's Clerk session,
enrolls an Ed25519 device identity, registers the workspace, discovers each
provider independently, and installs a repository-local Agent Fabric Skill and
API specification. It never writes a bearer token, local path, provider key,
or runtime identity into the repository.

After approval, the CLI prints the exact commands to sync reduced evidence and
start the outbound relay. Full raw trajectories remain encrypted in the local
vault. A customer can revoke the device from the dashboard without gaining or
granting inbound shell access.

The versioned TypeScript client is `@dharma-ai-labs/agent-fabric-sdk`; the Python
client is `dharma-agent-fabric-sdk`. Both call the organization-scoped Dharma
HQ API rather than customer cloud or internal worker endpoints.

See [the company onboarding and operations guide](docs/onboarding/customer-guide.md)
for the purchase, GitHub, CLI, managed ADK, GCP BYOK, evaluation, remediation,
cross-agent handoff, and offboarding flow.

## Codex plugin

The OpenAI plugin is submitted for review. Developer and reviewer tenants can
install the repository package while directory approval remains an external
gate:

```bash
codex plugin marketplace add dharma-ai-labs/dharma-agent-fabric
codex plugin add dharma-agent-fabric@dharma-ai-labs
codex mcp login dharma-agent-fabric
```

The plugin connects to the OAuth-protected MCP resource at
`https://mcp.dharma-ai.io/mcp`. Evidence expansion and every mutation require
explicit confirmation; organization membership and the underlying HQ API
capabilities remain authoritative.

## Development

```bash
mise exec node@22 -- npm install
mise exec node@22 -- npm test
mise exec node@22 -- npm run pack:verify
mise exec node@22 -- npm run load:relay
```

The `dharma` CLI is built from `packages/cli`. Use `--json` for parser-safe
output; diagnostics are written to stderr.

`load:relay` starts an isolated mock HQ and local relay, then proves 1,000
concurrent device connections, 10,000 relayed request envelopes, and a
1,000-device reconnect wave. Counts can be reduced for development with the
`AGENT_FABRIC_LOAD_DEVICES`, `AGENT_FABRIC_LOAD_MESSAGES`, and
`AGENT_FABRIC_LOAD_RECONNECT_DEVICES` environment variables.

## Security boundary

- raw provider evidence stays encrypted locally;
- only registered workspaces are eligible;
- secrets, credentials, private keys, excluded paths, and unrelated sessions
  are removed before capsule creation;
- remote tasks use isolated worktrees and registered commands;
- installed Skills are immutable signed bundles, never mutable branch heads;
- merge, deploy, secret, and destructive authority are denied by default.

## Better Harness attribution

Provider discovery and evidence concepts are derived in part from
[QoderAI/better-harness](https://github.com/QoderAI/better-harness), used under
the MIT License. See `THIRD_PARTY_NOTICES.md` and `LICENSES/`.
