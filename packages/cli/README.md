# `@dharma-ai-labs/agent-fabric`

The public `dharma` CLI connects approved local coding-agent workspaces to the
Dharma Agent Fabric control plane. It enrolls an outbound-only signed device,
discovers provider capabilities, keeps full trajectories in an encrypted local
vault, syncs policy-qualified evidence, executes bounded signed tasks, and
installs signed Skill releases with receipts and rollback ancestry.

## Autonomous organization setup

Requires Node.js 22.20.0 through 24.x.

An organization administrator copies the one-shot setup instruction from
**Portal → Agent Fabric → Instructions** into the coding agent that is already
open in the intended source repository. The instruction authorizes one pinned
command. The coding harness may show one native approval for that exact command;
after approval, no additional terminal steps or provider selection are required.

```bash
npm exec --yes --package=@dharma-ai-labs/agent-fabric@<version> -- dharma bootstrap \
  --portal-url https://www.dharma-ai.io \
  --organization-id <organization-id> \
  --grant <single-use-grant> \
  --workspace . \
  --policy-revision <dashboard-policy-revision> \
  --provider auto \
  --complete
```

`bootstrap` does not open a browser. It redeems the short-lived grant into an
Ed25519 device identity and a revocable, device-scoped organization API token,
stores both in the operating-system credential store, connects only the current
repository, obtains its signed policy, detects the active host, installs and
verifies its native skill, applies the signed evidence boundary, starts the
outbound relay, and verifies read-only organization access.
The grant is usable only until its displayed expiry and is never stored by HQ
in plaintext. Device revocation also revokes the linked organization token.

Success is one terminal JSON receipt with `ok: true`, `stage: "complete"`, a
ready provider skill, a running relay, and ready organization API reads. For
Claude Code, bootstrap also merges a project-local allowlist for later exact
read-only status commands into `.claude/settings.local.json`. Existing settings
and deny rules are preserved. The allowlist does not permit enrollment, evidence
sync, task dispatch, source writes, paid operations, release, rollout, or
rollback.

Use the separate teammate action in the Instructions tab to send a Clerk
organization invitation and copy a distinct one-time setup for that teammate.
The agent connection can complete before the teammate accepts portal access.

## Manual enrollment

Manual browser-confirmed enrollment remains available when no one-time grant is
issued:

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

## Managed evaluation workflow

Download the versioned task-package template and JSON Schema from the production
documentation, replace the example task with customer evidence, and validate the
exact contract and maximum credit charge before launching:

```bash
curl -fsSLO https://www.dharma-ai.io/templates/managed-evaluation-task-package-v1.json

dharma evaluations validate \
  --file managed-evaluation-task-package-v1.json \
  --agent-id <active-managed-agent-id> \
  --organization-id <organization-id>

dharma evaluations launch \
  --file managed-evaluation-task-package-v1.json \
  --agent-id <active-managed-agent-id> \
  --organization-id <organization-id> \
  --confirm
```

`validate` is read-only. It returns task count, trajectory count, configured
standard hard gates, maximum credits, and invoice-equivalent value without
running a model or debiting credits. `launch` repeats server validation and
requires explicit confirmation before creating the paid campaign. The package
always applies the standard Cognitive Integrity profile; an optional versioned
customer-domain rubric adds governed semantic or registered deterministic
dimensions without executing customer-supplied code.

```bash
dharma evaluations status --campaign-id <campaign-id> --organization-id <organization-id>
dharma evaluations results --campaign-id <campaign-id> --organization-id <organization-id>
```

`results` returns the persisted authoritative verdict used by the portal and
Control Agent. Scorer-only hidden truth is never returned by the read API.

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
- [Evaluation task package and API](https://www.dharma-ai.io/docs/evaluations)
- [Source and issue tracker](https://github.com/dharma-ai-labs/dharma-agent-fabric)
- [Customer onboarding guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [CLI command contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/22-cli-command-contract.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)

Licensed under MIT. Do not report security vulnerabilities in a public issue;
use the private security-reporting channel in the GitHub repository.
