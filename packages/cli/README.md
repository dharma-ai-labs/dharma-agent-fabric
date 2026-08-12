# `@dharma-ai-labs/agent-fabric`

The public `dharma` CLI connects approved local coding-agent workspaces to the
Dharma Agent Fabric control plane. It enrolls an outbound-only signed device,
discovers provider capabilities, keeps full trajectories in an encrypted local
vault, syncs policy-qualified evidence, executes bounded signed tasks, and
installs signed Skill releases with receipts and rollback ancestry.

## Start

Requires Node.js 22.20 or later.

```bash
npx --yes @dharma-ai-labs/agent-fabric@latest onboard \
  --hq-url https://www.dharma-ai.io \
  --organization-id <organization-id> \
  --policy-revision <dashboard-policy-revision> \
  --workspace "$PWD"
```

Current provider adapters are Codex, Claude Code, and Agy. Run
`dharma providers list` because evidence, task, continuation, Skill installation,
activation, and usage capabilities are reported independently.

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

- [Dharma AI](https://www.dharma-ai.io)
- [Source and issue tracker](https://github.com/dharma-ai-labs/dharma-agent-fabric)
- [Customer onboarding guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [CLI command contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/22-cli-command-contract.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)

Licensed under MIT. Do not report security vulnerabilities in a public issue;
use the private security-reporting channel in the GitHub repository.
