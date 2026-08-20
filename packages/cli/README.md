# `@dharma-ai-labs/agent-fabric`

The public `dharma` CLI connects approved local coding-agent workspaces to the
Dharma Agent Fabric control plane. It enrolls an outbound-only signed device,
discovers provider capabilities, keeps full trajectories in an encrypted local
vault, syncs policy-qualified evidence, executes bounded signed tasks, and
installs signed Skill releases with receipts and rollback ancestry.

## Start

Requires Node.js 22.20 or later.

```bash
npm install --global @dharma-ai-labs/agent-fabric
dharma login \
  --portal-url https://www.dharma-ai.io \
  --organization-id <organization-id>
dharma repositories discover --root "$HOME/work"
dharma repositories connect \
  --repo "$PWD" \
  --provider codex \
  --provider claude \
  --provider hermes \
  --organization-id <organization-id> \
  --policy-revision <dashboard-policy-revision>
dharma repositories status --repo "$PWD" --json
```

Repeat `--provider` to attach only the local runtimes that should serve the
selected repository agent. Omitting it preserves compatibility by attaching
every installed supported provider.

One selected source repository becomes one logical organization agent and one
permanent branch in the organization's private Dharma control repository.
Connecting that repository from another machine or provider adds an endpoint to
the same agent. The CLI derives repository identity from a credential-free
normalized Git remote. Repositories without a remote require an explicit stable
`--repository-key`; absolute paths are never identity.

Current provider adapters are Codex, Claude Code, Agy, and Hermes Agent. Run
`dharma providers list` because evidence, task, continuation, Skill installation,
activation, and usage capabilities are reported independently.

Agy 1.1.15 Skill activation uses only its supported plugin and sandboxed print
interfaces. During onboarding, Dharma adds the narrow read-only
`command(git status)` preflight to Agy's permission allowlist. It never uses
`--dangerously-skip-permissions`. A signed remediation Skill contains a
content-bound activation token; Agy must return that token with a fresh nonce
before the device signs an active installation receipt. A mismatch restores the
previous bundle before the receipt is posted.

Signed workspace registration returns the organization-admin-approved evidence
policy from Dharma HQ. The CLI applies that server revision to
`.dharma/approved-policy.json` automatically. Without an active content grant,
the policy remains `local_analysis`; with a current bounded grant, it switches
to `customer_authorized_content` with the server-issued receipt and upload
limits. A local flag or hand-edited receipt cannot grant content disclosure.
The running relay refreshes this policy from signed workspace registration every
minute, so an admin grant or withdrawal does not require a manual sync command.

Local metadata analysis is operational triage, not semantic Cognitive Integrity
evaluation. Nuanced scoring and remediation require approved, redacted evidence;
missing evidence must produce `insufficient_evidence`.

After a candidate pull request exists, an organization admin first authorizes
the candidate on one exact local endpoint. This is an evaluation-only canary,
not release approval:

```bash
dharma remediations act \
  --organization-id <organization-id> \
  --target-id <repository-remediation-target-id> \
  --action stage_evaluation \
  --json-body '{"endpointId":"<local-endpoint-id>"}' \
  --confirm
```

Run `dharma skills sync` with the returned evaluation authorization ID, then
collect 20 later non-source trajectories on that endpoint. The held-out gate
rejects trajectories that do not carry the installed candidate bundle ID:

```bash
dharma skills sync \
  --workspace-id <workspace-id> \
  --provider <codex|claude|agy|hermes> \
  --policy .dharma/approved-policy.json \
  --approval-id <evaluation-authorization-id>

dharma remediations act \
  --organization-id <organization-id> \
  --target-id <repository-remediation-target-id> \
  --action run_backtest \
  --body-file held-out-trajectories.json \
  --confirm
```

`held-out-trajectories.json` contains a `trajectoryIds` array with 20 to 100
UUIDs for that repository agent. HQ rejects source, older, cross-agent, deleted,
or unavailable evidence.

- [Dharma AI](https://www.dharma-ai.io)
- [Source and issue tracker](https://github.com/dharma-ai-labs/dharma-agent-fabric)
- [Customer onboarding guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [CLI command contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/22-cli-command-contract.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)

Licensed under MIT. Do not report security vulnerabilities in a public issue;
use the private security-reporting channel in the GitHub repository.
