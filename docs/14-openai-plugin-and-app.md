# OpenAI Plugin and App Distribution

## Distribution boundary

Dharma Agent Fabric ships a public Codex Skill and a remote MCP app. The Skill
provides workflow guidance. The app provides authenticated organization data
and bounded actions. ChatGPT and Codex never connect directly to a customer
relay, device, provider credential, or local filesystem.

The server implementation is in the private HQ repository. This public package
contains the matching tool catalog, plugin manifest, Skill, reviewer checklist,
and claim boundaries.

## Public Codex Skill

The included Skill supports:

- connecting and revoking a device;
- registering a repository-qualified workspace;
- inspecting Codex and Claude Code capabilities independently;
- previewing and synchronizing bounded trajectory capsules;
- inspecting and executing signed tasks in relay-owned worktrees;
- reviewing exact 100-trajectory evaluation windows and Failure Atlas families;
- installing, activating, receipting, and rolling back signed Skill bundles;
- explaining local BYOK, cloud BYOK, and managed-runtime billing boundaries.

Evidence capture, task execution, continuation, Skill installation, and Skill
activation are separate capabilities. The package does not imply that every
provider supports every capability.

## Remote MCP app

The MCP resource is `https://mcp.dharma-ai.io/mcp`. Clerk OAuth requires
`openid user:org:read`; every invocation is then authorized against the active
Dharma organization membership and the underlying HQ route capability.

The exact registered tools are maintained in
`plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json` and checked
during `npm run check`.

### Read tools

- `fabric_get_identity`
- `fabric_list_devices`
- `fabric_list_agents`
- `fabric_list_workspaces`
- `fabric_list_trajectories`
- `fabric_list_failure_atlas`
- `fabric_list_tasks`
- `fabric_list_a2a`
- `fabric_list_skills`
- `fabric_list_evals`
- `fabric_list_usage`

### Confirmed sensitive read

- `fabric_get_trajectory_evidence`

### Confirmed actions

- `fabric_create_agent`
- `fabric_bind_local_endpoint`
- `fabric_request_trajectory_evidence`
- `fabric_dispatch_task`
- `fabric_dispatch_a2a`
- `fabric_run_analysis`
- `fabric_release_skill`
- `fabric_rollout_skill`

`fabric_create_agent` creates only the logical organization identity;
`fabric_bind_local_endpoint` then attaches one enrolled, task-capable
workspace/provider without exposing its local path or credentials.
`fabric_run_analysis` evaluates an exact 100-trajectory window and may incur a
metered semantic-analysis charge. `fabric_release_skill` signs only an already
evaluated managed remediation or a signed empty rollback baseline.
`fabric_rollout_skill` is the atomic start,
expand, or rollback transition; R3 and R4 releases require organization-admin
approval.

## Authorization and confirmation

Clerk OAuth proves the user identity. Active Dharma organization membership,
not OAuth scope alone, decides access to the requested organization.

- owners and admins may use the full catalog;
- developers may use permitted read and execution scopes;
- developers cannot release or roll out Skills;
- inactive, absent, or cross-organization membership fails closed.

`fabric_get_identity` returns only the signed-in Clerk identity and that user's
membership-binding state for the requested organization. It is a bounded
reviewer diagnostic and does not enumerate organization members.

Explicit confirmation is required for every mutation and for evidence
expansion. Mutations also require an idempotency key. The same HQ route handlers
enforce capability flags, rate limits, audit correlation, KMS signing, and usage
settlement.

## Forbidden tools

The app does not expose arbitrary shell execution, arbitrary local file reads,
unbounded evidence upload, generic agent chat, branch merge, deployment, secret
retrieval, role mutation, or direct provider access.

## Publication sequence

1. Validate the public Skill package and exact tool catalog.
2. Deploy the HQ MCP endpoint behind Clerk OAuth.
3. Verify protected-resource metadata, dynamic client registration, and consent.
4. Connect a reviewer tenant and exercise every read tool.
5. Exercise every confirmed action with audit and idempotency proof.
6. Complete cross-tenant, revocation, signed rollout, and forced rollback tests.
7. Publish privacy, retention, deletion, terms, security, support, and reviewer
   documentation.
8. Submit to OpenAI review with a stable reviewer tenant.

Directory publication remains an external OpenAI review gate.

## Public listing claim

> Connect local Codex and Claude Code workspaces to organization-wide evaluation,
> bounded remote tasks, structured agent handoffs, and signed Skill updates while
> keeping local provider credentials on the device.

Do not claim universal provider support, zero-touch setup, arbitrary autonomous
deployment, guaranteed improvement, or general availability before the live
reviewer-tenant gates pass.
