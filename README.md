# Dharma Agent Fabric

Dharma Agent Fabric connects local coding agents to an organization-scoped
evaluation, remediation, task-orchestration, and signed Skill release system.

The public edge keeps complete raw trajectories in an encrypted local vault.
Workspace-qualified, policy-filtered trajectory capsules leave the device under
the organization's evidence policy. Local metadata is a triage layer, not the
semantic endpoint: factual grounding, reasoning validity, evidence
interpretation, sycophancy, and remediation require bounded content evidence
or a separately governed local semantic evaluator.
Every connection is outbound initiated; the server never receives an arbitrary
localhost shell or unrestricted file interface.

## Cognitive Integrity evidence ladder

Agent Fabric separates four controls that solve different problems:

1. **Local capture and deterministic analysis** keeps complete provider
   trajectories encrypted on the device and computes coverage, completion,
   runtime, tool-discipline, and policy signals.
2. **Evidence selection** uses those signals to select exact sessions and spans.
   An administrator can approve a bounded evidence request. Continuous
   content-bearing sync is a separate organization policy requiring durable
   content-class, retention, and secondary-use consent.
3. **Semantic evaluation** uses approved, redacted evidence to test perception,
   inference, evidence boundaries, sycophancy, and task-specific rubrics. Every
   result must record its evidence, model, prompt, rubric, confidence, usage,
   and cost.
4. **Governed remediation** links an evidence-backed Failure Atlas family to a
   candidate change, GitHub review, held-out and regression evidence, signed
   rollout, installation receipts, and rollback.

Metadata can identify where deeper review is warranted; it cannot establish
what a prompt meant or whether a conclusion followed from evidence. If an
evaluation lacks approved semantic evidence, the correct result is
`insufficient_evidence`, not a fabricated score or remediation.

## Initial host support

| Host | Evidence | Remote task | Continuation | Skill install | Activation |
| --- | --- | --- | --- | --- | --- |
| Codex CLI/Desktop | available | available when installed | unavailable | available when installed | next session |
| Claude Code | available | available when installed | unavailable | available when installed | next session |
| Agy 1.0.1 | partial | read-only partial | partial | available when installed | plugin enable + next session |
| Pi | unavailable | unavailable | unavailable | unavailable | unavailable |
| Other Better Harness hosts | evidence adapter work | unavailable | unavailable | unavailable | unavailable |

Each capability is verified independently. Evidence discovery does not imply
that task execution, continuation, or Skill activation works for that host.

## Customer onboarding

An organization starts at `https://www.dharma-ai.io/subscribe` with a local-agent
trial, a paid package, or an explicitly sponsored canary. Dharma creates one
private control repository under `dharma-ai-labs` and invites the customer's
GitHub account. Each selected source repository becomes one logical agent and
one permanent `agents/<slug>-<hash8>` branch in that control repository.

Install and enroll the CLI, then select repositories explicitly:

```bash
npm install --global @dharma-ai-labs/agent-fabric
dharma login \
  --portal-url https://www.dharma-ai.io \
  --organization-id <organization-id>
dharma repositories discover --root "$HOME/work"
dharma repositories connect \
  --repo "$PWD" \
  --organization-id <organization-id> \
  --policy-revision <dashboard-policy-revision>
```

Browser approval enrolls an Ed25519 device identity. Repository identity comes
from a credential-free normalized Git remote hash or an explicit stable key,
never an absolute path. Connecting the same repository from another machine or
provider reuses the logical agent and adds an endpoint. The CLI installs the
repository-scoped Agent Fabric Skill and a managed bootstrap Skill in every
detected provider's native Skill directory. It never writes a bearer token,
provider key, or runtime identity into the repository.

The command waits for browser approval and completes without a second resume
command. Verify Codex installation immediately afterwards:

```bash
dharma skills verify --provider codex --workspace .
```

Start a new Codex session from the connected repository after verification so
Codex reloads its Skill inventory. The Skill is named `dharma-agent-fabric`.

After approval, the CLI prints the exact commands to preview and sync an
automatic capsule and start the outbound relay. The initial organization policy
uses `local_analysis`: prompts, responses, instructions, tool I/O, execution
configuration, token metadata, encrypted reasoning, and full raw trajectories
remain encrypted locally, while deterministic counts, timing, coverage,
failure signals, and tool-discipline metadata are delivered to HQ.

The client policy contract supports `metadata_only`, `local_analysis`, and
`customer_authorized_content`. The third mode remains a release candidate until
HQ durably enforces the matching consent and retention contract; production HQ
must reject it until that server gate ships. Explicit, purpose-bound evidence
requests remain the current path to semantic review. Content is still locally
secret-redacted, workspace-bound, size-capped, previewable, and auditable.

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

- raw provider evidence stays encrypted locally unless the organization has an
  auditable customer-authorized content policy;
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
