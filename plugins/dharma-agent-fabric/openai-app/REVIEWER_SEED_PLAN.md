# Reviewer Demo Organization Seed Plan

This plan describes the fixed state that the ChatGPT app test cases in
`chatgpt-app-submission.json` need. Every expected output in that file assumes
exactly this state. If the state differs, the test case is not expected to pass.

This is a plan only. Nothing in this repository creates or changes data in a
Dharma organization. A Dharma operator runs these steps, and only after the
owner approves them.

## Why a fixed seed

OpenAI re-runs every submitted test case on ChatGPT web and on ChatGPT mobile,
one after the other, without resetting anything. A test case passes only if it
returns the documented result on both runs. So every submitted case:

- is one user turn that calls one read-only tool, so ChatGPT adds no approval
  step and no second turn decides the outcome;
- reads state that no submitted case changes; or
- is refused by the server for the same reason on every run.

Anything that a first call would create is created by the operator during
seeding, before the seed is frozen. The organization control agent is the main
example: the first control-agent call in an organization provisions it, which
adds a second agent to the agent listing. The seed provisions it up front, so
TC-2 sees the same two agents however often and in whatever order the cases
run.

Writes (task dispatch, control-agent conversations and messages) and cases
that consume state (a rollback that only works once, an analysis window, a
model-written answer) are not submitted. They are guided checks in
`REVIEWER_GUIDE.md`, run in a separate copy of the seed, never in the reviewer
organization.

## Accounts

| Account | Role in the reviewer organization | Who uses it |
| --- | --- | --- |
| Reviewer account | `developer` | OpenAI reviewers, through ChatGPT |
| Seed operator account | `org_admin` | Dharma operator only, for the steps below |

[NICK-DECIDES: the reviewer account role. This plan assumes `developer`. With
`developer`, admin-only tools are refused with `insufficient_scope`, and TC-5
relies on that. If the reviewer gets `org_admin`, TC-5 and TC-6 change: an
admin can list workspaces and sees every conversation, including the
operator's seeding conversation.]

[NICK-DECIDES: reuse the existing reviewer organization, or create a dedicated
one for this seed. A dedicated organization is simpler to keep exact, because
any earlier trajectory, agent, conversation or repository in the existing one
changes TC-2, TC-3 and TC-6.]

Reviewer credentials and the organization ID go to OpenAI through the private
review channel. They are never committed.

## Placeholders

The submission uses these placeholders. Before the package is pasted into the
OpenAI form, the operator replaces each one with the value recorded in the
private seed receipt. The substituted copy is never committed.

| Placeholder | Value | Recorded in step |
| --- | --- | --- |
| `{{REVIEWER_ORG_ID}}` | Reviewer organization ID | 1 |
| `{{REVIEWER_WORKSPACE_ID}}` | Workspace ID of the demo repository | 3 |
| `{{REVIEWER_AGENT_KEY}}` | Agent key of the repository agent | 3 |
| `{{REVIEWER_CODEX_ENDPOINT_ID}}` | ID of the one active Codex endpoint | 3 |
| `{{REVIEWER_T1_CAPSULE_HASH}}` | `capsule_hash` of trajectory 1, revision 1 | 4 |
| `{{REVIEWER_CONTROL_ENDPOINT_ID}}` | ID of the control agent's managed runtime endpoint | 7 |

The five trajectory IDs are fixed and are not placeholders:

| Trajectory | ID |
| --- | --- |
| T1 | `5eed0000-0000-4000-8000-000000000001` |
| T2 | `5eed0000-0000-4000-8000-000000000002` |
| T3 | `5eed0000-0000-4000-8000-000000000003` |
| T4 | `5eed0000-0000-4000-8000-000000000004` |
| T5 | `5eed0000-0000-4000-8000-000000000005` |

## Required state

| Item | Exact state | Used by |
| --- | --- | --- |
| Organization | Agent Fabric active, enrollment capability on | all |
| Runtime activation | The organization's managed runtime activation entitlement is `ready`, which the control agent needs | TC-2, TC-6 |
| Control agent | The organization control agent (`dharma:organization-control-agent`) is provisioned and `ready`, with exactly one `managed_runtime` endpoint, `active` | TC-2, TC-6 |
| Members | One `developer` reviewer, bound to the reviewer's sign-in; one operator admin | TC-1, TC-5, TC-6 |
| Repository-agent model | On for the reviewer organization; the onboarding step `repository_agent` is complete | step 3 |
| GitHub App and control repository | The Dharma GitHub App is installed on a Dharma-controlled demo GitHub organization, and the organization's control repository is provisioned in that same GitHub organization; the onboarding steps `github_app` and `repository` are complete | step 3 |
| Repository | One synthetic public demo repository whose `README.md` starts with `# Dharma reviewer demo`, cloned on the seed device at a path that has no Codex session history | step 3 |
| Device | One Dharma-controlled seed device enrolled in the organization, relay stopped after seeding | TC-2 |
| Workspace | One workspace for the demo repository | TC-2, TC-3 |
| Repository agent | Exactly one, with exactly one endpoint: `local_provider`, `codex`, `local_device`, `active` | TC-2 |
| Trajectories | Exactly T1 to T5, ingested in that order, each revision 1, provider `codex`, evidence mode `structured`, capsule status `completed` (stored as `observed`) | TC-3, TC-4 |
| Conversations | None created by the reviewer account. The operator's seeding conversation exists but a developer member does not see it | TC-6 |
| Not present | No learning policy, no scheduled analysis, no control-agent message, no other device, workspace, agent or trajectory | TC-2, TC-3 |

Trajectory capsules carry only synthetic text written for this seed. They never
contain customer data, real transcripts or credentials. No control-agent
message is ever sent in the reviewer organization: a control-agent turn records
a managed trajectory, which would change TC-3.

## Seed steps

Each step uses an existing product surface. Record every returned ID in the
private seed receipt.

1. **Organization and readiness check.** Use the reviewer organization (see
   the decision above). Record `{{REVIEWER_ORG_ID}}`. **Readiness check:**
   as the operator, read the organization's Agent Fabric onboarding status
   (the portal's Agent Fabric onboarding page, which reads
   `GET /api/v1/orgs/{organizationId}/agent-fabric/onboarding`). It changes
   nothing. Continue only if the steps `runtime`, `github_app`, `repository`
   and `repository_agent` are all complete and `repositoryAgent.enabled` is
   `true`. Do not run any `dharma` command against the organization before
   this check passes: the CLI registers the workspace before it requests the
   repository bind, so a bind that the server refuses still leaves a
   registered workspace and agent behind.
   [NICK-DECIDES: approval for the owner-only production HQ changes this step
   may need for the reviewer organization: the runtime activation entitlement,
   the organization control agent, the repository-agent model, the Dharma
   GitHub App installation on a Dharma-controlled demo GitHub organization
   and the control repository in it. If a GitHub App installation for the
   seed is not acceptable, the seed cannot be built with today's CLI: it
   first needs a CLI change that registers a workspace without the
   repository bind.]
2. **Members.** Invite the reviewer account as `developer` through the Dharma
   portal. After the reviewer's first sign-in, `fabric_get_identity` must
   report `bindingState` `bound`.
3. **Device, workspace, repository agent and endpoint.** On the seed device,
   as the operator, enroll the device and connect the demo repository with
   `dharma repositories connect`. This is the only enrollment path in this
   plan. `dharma workspace sync` is not an alternative: it always registers
   the workspace and then requests the repository-agent bind
   (`POST /agent-fabric/repository-agents`), which the server refuses with
   `agent_fabric_repository_agents_not_enabled` when the repository-agent
   model is off. No enrollment command registers a workspace without that
   bind.

   First check that the clone has no Codex history on the seed device.
   Connect syncs up to 20 existing Codex sessions of the workspace as its
   first learning evidence, which would add trajectories before T1. This
   command reads local files only:

   ```bash
   dharma evidence preview --workspace <demo-repo-path> --provider codex
   ```

   It must report `trajectoryCount` 0. Otherwise use a fresh clone at a new
   path. Then connect:

   ```bash
   dharma login --portal-url https://www.dharma-ai.io --organization-id {{REVIEWER_ORG_ID}}
   dharma repositories connect --repo <demo-repo-path> --provider codex --organization-id {{REVIEWER_ORG_ID}} --policy-revision <dashboard-policy-revision>
   ```

   With the repository-agent model on, the server registers the workspace
   with one repository-scoped agent (agent key `repo:<24 hex characters>`)
   and one `local_provider` endpoint per attached provider, with credential
   boundary `local_device`. Connect then creates the agent's control branch
   in the control repository through the GitHub App, submits a package
   candidate of the synthetic demo repository, which the server then
   publishes to the control repository, and starts the relay. The control
   branch and the package publication are GitHub writes, so they need GitHub
   writes to be on in production (`AGENT_FABRIC_DISABLE_GITHUB_WRITES` not
   `true`). The control repository is not an agent, so it adds nothing to the
   agent listing. If connect fails or returns `ok` false, resolve the stage
   or code it names (for example approve the repository source scope as the
   operator) and rerun the same command.

   Attach only `codex`. Then call `fabric_list_agents` and
   `fabric_list_workspaces` as the operator. There must be exactly one agent,
   the `repo:` agent, with exactly one Codex endpoint, `active`, and exactly
   one workspace. If there is any other agent, endpoint or workspace, do not
   continue: rebuild the organization from step 1. Record
   `{{REVIEWER_WORKSPACE_ID}}`, `{{REVIEWER_AGENT_KEY}}` and
   `{{REVIEWER_CODEX_ENDPOINT_ID}}`. Between this step and step 5, do not use
   Codex on the seed device for anything else: while the relay runs, every
   Codex session there is captured and synced as an extra trajectory.
4. **Trajectories.** From the enrolled seed device, submit five
   device-signed trajectory capsules through the relay's trajectory sync
   (`POST /api/v1/orgs/{organizationId}/agent-fabric/trajectories`), one at a
   time in order T1 to T5, with the fixed IDs above, revision 1, provider
   `codex`, evidence mode `structured` and status `completed`. Then call
   `fabric_get_trajectory_evidence` for T1 as the operator and record its
   revision 1 `capsule_hash` as `{{REVIEWER_T1_CAPSULE_HASH}}`.
   [NICK-DECIDES: whether a small signed-capsule seed writer may be added to
   the private operations repository for this step, or whether the operator
   runs five short scripted Codex sessions in the demo repository and accepts
   the IDs the relay assigns. The second option makes the trajectory IDs
   placeholders too, and the relay's capture policy, not this plan, then sets
   status, evidence mode and order. The count check in step 6 catches a
   mismatch either way.]
5. **Stop the relay.** Stop the relay on the seed device and leave the device
   enrolled. No new trajectory can arrive after this.
6. **Trajectory count check.** As the operator, call
   `fabric_list_trajectories` with `limit` 10. It must return exactly 5 rows,
   T5 to T1 newest first, each with provider `codex`, evidence mode
   `structured`, status `observed`, latest revision 1 and workspace
   `{{REVIEWER_WORKSPACE_ID}}`. If it returns more or different rows, do not
   continue: rebuild the organization from step 1.
7. **Control agent.** As the operator, call
   `fabric_control_agent_create_session` once with title `Seed provisioning`.
   On the first call in an organization this provisions the organization
   control agent: it adds the agent `dharma:organization-control-agent` and
   its `managed_runtime` endpoint and deploys a managed runtime revision. If it
   returns `control_agent_provisioning_in_progress`, wait and repeat with the
   same idempotency key until the control agent is `ready`. Do not send a
   message. Then call `fabric_list_agents` as the operator. It must return
   exactly two agents: the repository agent from step 3 and the control agent
   with exactly one `managed_runtime` endpoint, `active`. Record that endpoint
   as `{{REVIEWER_CONTROL_ENDPOINT_ID}}`. Call `fabric_list_trajectories`
   again with `limit` 10: it must still return exactly T1 to T5.
8. **Freeze the seed.** Record the seed receipt privately: every placeholder
   value, the step 6 and step 7 readbacks and the time. From now on nobody
   uses the operator or reviewer account in this organization except for the
   acceptance runs below.

## Acceptance before submission

1. Connect ChatGPT (developer mode) to `https://mcp.dharma-ai.io/mcp` as the
   reviewer account.
2. Run TC-1 to TC-6 and the three negative cases on ChatGPT web, then on
   ChatGPT mobile, with the substituted prompts. Then run them again in the
   opposite order.
3. Each result must match its expected output in `chatgpt-app-submission.json`.
   Fields the expected output does not name (timestamps, correlation IDs) may
   differ.
4. Capture `tools/list` with the reviewer session, project it with
   `scripts/mcp-tools-list-project.mjs`, and run
   `node scripts/verify-mcp-catalog.mjs --snapshot-manifest <manifest.json>`.
   The verdict must be `compatible`.
5. Repeat steps 2 and 3 after 48 hours with the relay still stopped, to show
   that the Codex endpoint stays `active` and TC-2 is unchanged.

If any result differs, fix the seed or the expected output in this repository
before submitting. Do not submit expected outputs that were not observed.

## Reset

| Created by a test run | Effect on other cases | Reset needed |
| --- | --- | --- |
| Nothing. Every submitted case is a read or a refused read. | None | No |

Between OpenAI review rounds nothing needs resetting. If the seed is damaged
(for example the relay was restarted and new trajectories arrived, another
agent was created, or the reviewer account created a conversation), do not try
to delete individual records. Rebuild the reviewer organization from step 1
and record new placeholder values.
