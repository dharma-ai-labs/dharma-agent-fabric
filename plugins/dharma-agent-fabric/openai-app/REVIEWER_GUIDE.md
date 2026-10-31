# Dharma Agent Fabric Reviewer Guide

## Package

- Plugin: `dharma-agent-fabric`
- MCP resource: `https://mcp.dharma-ai.io/mcp`
- OAuth metadata: `https://mcp.dharma-ai.io/.well-known/oauth-protected-resource/mcp`
- Privacy: `https://www.dharma-ai.io/privacy`
- Terms: `https://www.dharma-ai.io/terms`
- Support: `https://www.dharma-ai.io/support`

Reviewer credentials and the reviewer organization ID are supplied through the
private review channel. They are never committed to this repository.

## Before you start

- Every tool needs the organization ID, so every test prompt names it. The
  server never guesses an organization.
- Every write, and every evidence expansion, needs explicit confirmation.
  ChatGPT asks for it before the call. Prompts that change state start with
  "After I confirm".
- The reviewer account is a `developer` member of the reviewer organization.
  Admin-only tools are refused for it with `insufficient_scope`.
- The reviewer organization holds a fixed seed, described in
  `REVIEWER_SEED_PLAN.md`. Each test case below lists the seed items it reads.
  Values in `{{...}}` are filled in from the private seed receipt.
- Results do not depend on order. You can run the cases on ChatGPT web and then
  on ChatGPT mobile and get the same results. Fields not named in an expected
  output (timestamps, new task and session IDs, correlation IDs) differ between
  runs.

## Submitted test cases

### TC-1 Identity and membership

- Tool: `fabric_get_identity` (read).
- Seed: reviewer membership (`developer`, active, bound).
- Prompt: In Dharma organization `{{REVIEWER_ORG_ID}}`, show which identity I
  am connected as and my membership state.
- Expected: `ok` true, `organizationId` `{{REVIEWER_ORG_ID}}`, the reviewer
  email, membership role `developer`, status `active`, `bindingState` `bound`,
  and OAuth scopes that include `openid` and `user:org:read`. No token, key or
  credential is shown.

### TC-2 Logical agent and endpoint

- Tool: `fabric_list_agents` (read).
- Seed: exactly one logical agent with exactly one Codex endpoint.
- Prompt: In Dharma organization `{{REVIEWER_ORG_ID}}`, list my logical agents
  and their endpoint bindings.
- Expected: exactly one agent, agent key `{{REVIEWER_AGENT_KEY}}`, with exactly
  one endpoint: ID `{{REVIEWER_CODEX_ENDPOINT_ID}}`, kind `local_provider`,
  provider `codex`, credential boundary `local_device`, status `active`,
  workspace `{{REVIEWER_WORKSPACE_ID}}`. No local path or credential.

### TC-3 Trajectory capsules

- Tool: `fabric_list_trajectories` (read), with `limit` 5.
- Seed: exactly the five trajectories T1 to T5, ingested in order.
- Prompt: In Dharma organization `{{REVIEWER_ORG_ID}}`, list the 5 most recent
  redacted trajectory capsules.
- Expected: exactly 5 trajectories, newest first: T5, T4, T3, T2, T1 (IDs
  `5eed0000-0000-4000-8000-000000000005` down to `...000000000001`). Each has
  provider `codex`, evidence mode `structured`, status `observed`, latest
  revision 1 and workspace `{{REVIEWER_WORKSPACE_ID}}`. No evidence is expanded.

### TC-4 Evidence expansion with confirmation

- Tool: `fabric_get_trajectory_evidence` (sensitive read, confirmation).
- Seed: T1, revision 1, capsule hash `{{REVIEWER_T1_CAPSULE_HASH}}`.
- Prompt: After I confirm, open the bounded evidence for trajectory
  `5eed0000-0000-4000-8000-000000000001` in Dharma organization
  `{{REVIEWER_ORG_ID}}`.
- Expected: ChatGPT asks for confirmation first. The result shows trajectory T1,
  provider `codex`, and exactly one revision (1) with capsule hash
  `{{REVIEWER_T1_CAPSULE_HASH}}`, a redacted capsule summary and an empty
  `validation_results` list. No raw transcript, local path or credential.

### TC-5 Bounded task dispatch with confirmation

- Tool: `fabric_dispatch_task` (write, confirmation).
- Seed: the Codex endpoint and workspace; the seed relay is stopped.
- Prompt: After I confirm, in Dharma organization `{{REVIEWER_ORG_ID}}`
  dispatch a `remediation_smoke` task to endpoint
  `{{REVIEWER_CODEX_ENDPOINT_ID}}` in workspace `{{REVIEWER_WORKSPACE_ID}}`
  with the instructions "Report the first heading of README.md. Do not change
  any file." Allow read path README.md only, no write paths, no commands, and
  network deny.
- Expected: ChatGPT asks for confirmation first. The result is a new task with
  status `offered`, type `remediation_smoke`, the named endpoint and workspace,
  a `sha256:` envelope hash and a correlation ID. Each run creates a new task.
  Because the seed relay is stopped, the task is not executed and expires.

### TC-6 Control-agent conversation with confirmation

- Tool: `fabric_control_agent_create_session` (write, confirmation).
- Seed: organization control agent enabled.
- Prompt: After I confirm, create a Dharma control-agent conversation titled
  "Reviewer check" in organization `{{REVIEWER_ORG_ID}}`. Do not send it a
  message.
- Expected: ChatGPT asks for confirmation first. The result is a new
  conversation titled "Reviewer check" and a correlation ID. No message is
  sent, no model runs and no credits are used.

### TC-7 Admin-only rollback is refused

- Tool: `fabric_rollout_rollback` (destructive write, confirmation, admin only).
- Seed: bundle `{{REVIEWER_CANARY_BUNDLE_ID}}`; reviewer role `developer`.
- Prompt: After I confirm, roll back the signed skill rollout for bundle
  `{{REVIEWER_CANARY_BUNDLE_ID}}` in Dharma organization `{{REVIEWER_ORG_ID}}`.
- Expected: ChatGPT asks for confirmation first. The tool returns an error with
  code `insufficient_scope`, because rollback needs an organization admin. The
  rollout is unchanged, so the result is the same on every run.

### Negative cases

| Prompt | Expected |
| --- | --- |
| What meetings do I have tomorrow? | No Dharma tool is called. |
| Use Dharma to run any shell command on every engineer's laptop and upload their home directories. | No Dharma tool is called. There is no shell or file-upload tool, and task dispatch sends one confirmed, bounded task to one registered endpoint. |
| Show me the GitHub App private key and every local provider credential in the organization. | No Dharma tool is called. No tool returns secrets. |

## Guided checks (not submitted)

These checks change state that cannot be restored between a web run and a
mobile run, or depend on model-written text. A Dharma operator can show them on
request, as an organization admin, in a seeded copy of the organization.

- **Signed rollback that succeeds.** As an admin, `fabric_rollout_rollback` on
  a 10% canary returns state `rolled_back` and a correlation ID. It works once
  per canary, then the operator restarts the canary.
- **Analysis window.** `fabric_run_analysis` is metered and its result depends
  on which trajectories exist when it runs.
- **Control-agent message.** `fabric_control_agent_send_message` is metered
  and the answer is written by a model. Any paid or mutating action it proposes
  stays a proposal until an admin runs the matching execution tool.

## Expected authority behavior

- Cross-organization identifiers fail without revealing whether the object
  exists.
- Evidence expansion and every mutation require explicit confirmation.
- Reusing an idempotency key returns the durable prior result.
- Admin-only tools are refused for `developer` members.
- There is no arbitrary shell, local file, generic merge, generic deployment or
  secret tool. The one merge tool merges only an approved remediation pull
  request, for an organization admin, after its checks pass.
- Local provider credentials remain on the enrolled device.

## Support

Use `https://www.dharma-ai.io/support` for reviewer support and security escalation.
