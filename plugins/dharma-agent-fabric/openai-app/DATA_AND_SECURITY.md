# Data, Privacy, and Security Summary

Dharma Agent Fabric receives bounded, policy-filtered trajectory capsules from
an outbound-only local relay. Full local evidence remains in the encrypted local
vault unless an authorized user explicitly confirms a bounded evidence request.

The remote MCP server:

- authenticates through Clerk OAuth;
- verifies active organization membership and role on every invocation;
- applies the same capability, rate-limit, audit, billing, and tenant boundaries
  as the underlying Dharma HQ APIs;
- requires idempotency keys for mutations;
- requires explicit confirmation for evidence expansion and every mutation;
- limits rollout, remediation, learning-policy and control-agent execution tools
  to organization admins;
- does not expose arbitrary shell execution, local file reads, secrets, direct
  provider credentials, or role and membership changes.

Two kinds of tool reach outside Dharma's own records, and both are limited to
organization admins:

- `fabric_remediation_merge_pr` merges one exact approved remediation pull
  request in the organization's own GitHub repository. It keeps the current
  head, provenance, check and approval gates and does not bypass a failed
  check. There is no tool that merges an arbitrary branch.
- Release and rollout tools (`fabric_release_skill`, `fabric_rollout_*`,
  `fabric_remediation_release`, `fabric_remediation_expand`,
  `fabric_remediation_rollback` and the matching control-agent execution tools)
  change signed skill installations on the organization's own endpoints and
  runtimes. There is no tool that deploys an application or environment.

`live-mcp-tools.snapshot.json` lists every tool with its annotations, and
`mcp-tool-catalog.json` lists its backend scope and whether it is admin-only.

Retention and deletion follow the published Dharma privacy policy and the
customer organization's configured retention policy. Device revocation prevents
new relay work immediately; signed task leases and Skill rollouts remain
auditable as immutable receipts.

- Privacy: `https://www.dharma-ai.io/privacy`
- Terms: `https://www.dharma-ai.io/terms`
- Support: `https://www.dharma-ai.io/support`
