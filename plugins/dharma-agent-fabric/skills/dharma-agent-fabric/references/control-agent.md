# Organization control agent

Use the organization control agent for organization-scoped inspection,
planning, and bounded orchestration. It is a managed Agent Fabric endpoint, so
its own messages, tool proposals, usage, and trajectories are auditable.

## From an enrolled local device

```text
dharma assistant chat --message "Summarize the newest failure family" --confirm
dharma assistant history
dharma assistant status --session-id <session-id>
```

`chat` is a metered managed run and therefore requires `--confirm`. The CLI
uses the enrolled device signature; do not add an organization bearer token to
the command or prompt.

## Proposals and approvals

Reads may complete automatically through the server-side organization tool
broker. Paid or mutating tools are stored as proposals. Inspect the proposal's
exact action, target, authority class, estimated cost, and source links before
deciding.

```text
dharma assistant approve --session-id <session-id> --tool-call-id <tool-call-id>
dharma assistant reject --session-id <session-id> --tool-call-id <tool-call-id>
```

These commands open the authenticated Dharma portal at the selected proposal.
They do not approve or reject it from the command line. An organization admin
must make the final decision in the portal, where the server rechecks role,
scope, feature flag, idempotency, and action policy.

## Authority boundary

- No browser or local client calls a private GCP, model, RAG, or worker URL.
- No tool returns provider credentials, cloud identities, or unrestricted
  filesystem data.
- Cross-agent work is a signed, expiring, task-bound request to an authorized
  endpoint, not arbitrary chat or shell access.
- R3 and R4 remediation and destructive operations remain organization-admin
  approved.
- If the control-agent capability is disabled or the organization is not
  allowlisted, report that state instead of simulating a result.
