# Dharma Agent Fabric

Dharma Agent Fabric connects local coding agents to an organization-scoped
evaluation, remediation, task-orchestration, and signed Skill release system.

The public edge keeps complete raw trajectories in an encrypted local vault.
Only workspace-qualified, policy-filtered trajectory capsules leave the device.
Every connection is outbound initiated; the server never receives an arbitrary
localhost shell or unrestricted file interface.

## Initial host support

| Host | Evidence | Remote task | Skill install | Activation |
| --- | --- | --- | --- | --- |
| Codex CLI/Desktop | available | pilot | pilot | next session |
| Claude Code | available | pilot | pilot | next session |
| Other Better Harness hosts | evidence adapter work | unavailable | unavailable | unavailable |

Each capability is verified independently. Evidence discovery does not imply
that task execution, continuation, or Skill activation works for that host.

## Development

```bash
mise exec node@22.22.3 -- npm install
mise exec node@22.22.3 -- npm test
mise exec node@22.22.3 -- npm run pack:verify
mise exec node@22.22.3 -- npm run load:relay
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
