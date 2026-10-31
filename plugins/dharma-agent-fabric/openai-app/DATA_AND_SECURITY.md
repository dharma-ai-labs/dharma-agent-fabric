# Data, Privacy, and Security Summary

This summary follows the revised Dharma privacy policy for Agent Fabric and the
ChatGPT app. Until that revision is published at
`https://www.dharma-ai.io/privacy`, this file is a draft and the publication
checklist keeps the privacy items open.

[NICK-DECIDES: approval of this text together with the privacy policy
revision, including the public disclosure of content synchronization
(`customer_authorized_content` capsules and `native_provider_payload`
records), the Cloud KMS payload statement and the subprocessor list below.]

## Data paths

Dharma Agent Fabric has two data paths:

1. **ChatGPT and other MCP clients** call the hosted MCP server at
   `https://mcp.dharma-ai.io/mcp`. Each call is authenticated with Clerk OAuth.
   The server requires the scopes `openid` and `user:org:read`; a client can
   also be granted `profile` and `email`. Each call is checked against active
   organization membership and role, and handled by the same organization
   APIs, capability checks, rate limits, audit and billing as the Dharma
   portal.
2. **The local relay** on an enrolled device opens outbound connections only.
   By default it uploads metadata-only trajectory capsules: IDs, provider name,
   a pseudonymous session ID, event kinds, times, sizes, local deterministic
   analysis counts, hashes and a redaction receipt. The server rejects default
   capsules that carry any other field or a local path.

## When content leaves the device

Full local evidence stays in the device's encrypted local vault except in
these cases:

- **Content synchronization.** When an organization admin turns on the
  organization's content disclosure policy and confirms it, the relay uploads
  content-bearing capsules automatically, in disclosure mode
  `customer_authorized_content`, with no further confirmation per capsule.
  Under that policy the relay can also sync `native_provider_payload` records,
  which are the provider's own transcript records. The admin chooses a
  retention period of 1 to 365 days. Caps are 1 MiB per capsule and 1 GiB per
  day. Excluded paths (`.env*`, `.git`, keys, `node_modules`, build output)
  are removed and secret-like values are rejected. Withdrawing consent
  replaces the synchronized content with tombstones at once. A withdrawal is
  refused while an analysis is running over that content.
- **Evidence requests.** A member confirms a request for up to 25 selectors
  and 256 KiB, for a stated purpose. The device applies its policy, redaction
  and byte cap first.
- **Repository source content.** Once an owner approves the organization
  source policy, every repository that an active member later connects is
  authorized for the whole repository, with automatic publication of
  validated snapshots, no default expiry and a daily cap of 50,000,000 bytes.
  Files over 256 KiB, snapshots over 4 MiB and secret-bearing paths are
  always excluded.

## Tools that reach outside Dharma's own records

| Tool | Who can call it | Where it reaches |
| --- | --- | --- |
| `fabric_dispatch_task`, `fabric_dispatch_a2a` | members with run scope (`developer` and admins) | the organization's own registered endpoint or device, which runs the bounded task |
| `fabric_request_trajectory_evidence` | members with trace scope | the source device, which answers under its own policy |
| `fabric_run_analysis` | members with evaluation run scope | Google Cloud (Vertex AI or Agent Platform); it may open a private remediation pull request in the organization's GitHub repository |
| `fabric_control_agent_send_message` | members with run scope | a metered Gemini turn on Vertex AI through Dharma's managed runtime on Google Cloud, over bounded organization reads |
| `fabric_control_agent_create_session` | members with run scope | on the first call in an organization, provisions the control agent and deploys a managed runtime revision on Google Cloud |
| `fabric_bind_runtime_endpoint` | members with run scope | binds an already deployed managed runtime to a logical agent, so later tasks can reach it |
| `fabric_control_execute_managed_run`, `fabric_control_execute_evaluation_campaign`, `fabric_control_execute_analysis` | organization admins | the managed runtime on Google Cloud, or the customer's own cloud project when the organization brings its own; a managed run prompt can be up to 100,000 characters |
| `fabric_remediation_merge_pr` | organization admins | the organization's GitHub repository: merges one exact approved remediation pull request, keeping the head, provenance, check and approval gates |
| `fabric_release_skill`, `fabric_rollout_*`, `fabric_remediation_release`, `fabric_remediation_expand`, `fabric_remediation_rollback` and the matching control-agent execution tools | organization admins | signed skill installations on the organization's own endpoints and runtimes |

The ChatGPT app declares only the tools in the ChatGPT profile (see
`README.md`). None of the admin-only tools in the last three rows is in it.
There is no tool that runs arbitrary shell commands, reads local files,
returns secrets or provider credentials, changes roles or membership, merges
an arbitrary branch or deploys an application or environment.

`live-mcp-tools.snapshot.json` lists every tool the hosted server registers,
with its annotations. `mcp-tool-catalog.json` lists its backend scope, whether
it is admin-only and whether it is in the ChatGPT profile.

## Recipients

| Recipient | Role |
| --- | --- |
| Clerk | sign-in and OAuth: account identity, email and organization membership |
| Google Cloud | Vertex AI (Gemini) for analysis, learning and the control agent; the managed runtime; Cloud KMS, which receives the full canonical task, skill and receipt payload bytes to sign them, not only a digest |
| GitHub | the Dharma GitHub App: repositories, pull requests, checks and the approved remediation merge |
| Vercel | hosting and request logs |
| Supabase | the database |
| Stripe | Agent Fabric checkout and billing |
| Resend | a new-account notice with the user's name and email, sent to a Dharma staff mailbox |
| Recipients the customer chooses | the organization's own devices, endpoints, GitHub repositories and, when it brings its own, cloud projects |

Agent Fabric code paths send no data to OpenAI beyond the tool results ChatGPT
receives for the calls a user makes.

## Retention

- Default capsules become tombstones 90 days after upload.
- Synchronized content follows the admin's retention period of 1 to 365 days,
  and is replaced by tombstones at once when consent is withdrawn.
- 24-hour evidence responses are removed 24 hours after completion.
- Learning material expires with its source content.
- Revoking a device stops new relay work at once. Signed task leases, skill
  rollouts and receipts stay auditable as immutable receipts.

[NICK-DECIDES: retention for tasks, A2A handoffs and control-agent
conversations, which have no automatic deletion today, and for billing, audit
and hosting logs. Use the same choice as the privacy policy revision.]

- Privacy: `https://www.dharma-ai.io/privacy`
- Terms: `https://www.dharma-ai.io/terms`
- Support: `https://www.dharma-ai.io/support`
