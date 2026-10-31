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
returns the documented result on both runs. So each case must:

- read state that no other case changes; or
- create a new record each time (a task or a conversation) whose shape is the
  same on every run; or
- be refused by the server for the same reason on every run.

Cases that consume state (a rollback that only works once, an analysis window
over "the next 100" trajectories, a model-written answer) cannot meet that bar
and are not submitted. They stay as guided checks in `REVIEWER_GUIDE.md`.

## Accounts

| Account | Role in the reviewer organization | Who uses it |
| --- | --- | --- |
| Reviewer account | `developer` | OpenAI reviewers, through ChatGPT |
| Seed operator account | `org_admin` | Dharma operator only, for the steps below |

[NICK-DECIDES: the reviewer account role. This plan assumes `developer`. With
`developer`, every admin-only tool (rollout, remediation, learning policy,
control-agent execution) is refused with `insufficient_scope`, and TC-7 relies
on that. If the reviewer gets `org_admin`, TC-7 must move to the guided checks,
because a real rollback can succeed only once.]

[NICK-DECIDES: reuse the existing reviewer organization, or create a dedicated
one for this seed. A dedicated organization is simpler to keep exact, because
any earlier trajectory, agent or repository in the existing one changes TC-2
and TC-3.]

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
| `{{REVIEWER_AGENT_KEY}}` | Agent key of the one logical agent | 3 |
| `{{REVIEWER_CODEX_ENDPOINT_ID}}` | ID of the one active Codex endpoint | 3 |
| `{{REVIEWER_T1_CAPSULE_HASH}}` | `capsule_hash` of trajectory 1, revision 1 | 4 |
| `{{REVIEWER_CANARY_BUNDLE_ID}}` | Bundle ID used by TC-7 | 6 |

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
| Organization | Agent Fabric active; organization control agent enabled for this organization | all |
| Members | One `developer` reviewer, bound to the reviewer's sign-in; one operator admin | TC-1, TC-7 |
| Repository | One synthetic public demo repository whose `README.md` starts with `# Dharma reviewer demo` | TC-5 |
| Device | One Dharma-controlled seed device enrolled in the organization, relay stopped after seeding | TC-2, TC-5 |
| Workspace | One workspace for the demo repository | TC-2, TC-3, TC-5 |
| Logical agent | Exactly one, with exactly one endpoint: `local_provider`, `codex`, `local_device`, `active` | TC-2, TC-5 |
| Trajectories | Exactly T1 to T5, ingested in that order, each revision 1, provider `codex`, evidence mode `structured`, capsule status `completed` (stored as `observed`) | TC-3, TC-4 |
| Bundle | One bundle in the organization for TC-7 | TC-7 |
| Not present | No GitHub App installation, no learning policy, no scheduled analysis, no other device, workspace, agent or trajectory | TC-2, TC-3 |

Trajectory capsules carry only synthetic text written for this seed. They never
contain customer data, real transcripts or credentials.

## Seed steps

Each step uses an existing product surface. Record every returned ID in the
private seed receipt.

1. **Organization.** Use the reviewer organization (see the decision above).
   Confirm that Agent Fabric is active and the organization control agent is
   enabled for it. Record `{{REVIEWER_ORG_ID}}`.
2. **Members.** Invite the reviewer account as `developer` through the Dharma
   portal. After the reviewer's first sign-in, `fabric_get_identity` must
   report `bindingState` `bound`.
3. **Device, workspace, agent and endpoint.** On the seed device, as the
   operator, follow the manual enrollment in the CLI README:
   `dharma login --organization-id {{REVIEWER_ORG_ID}}`, then
   `dharma repositories connect --repo <demo-repo> --provider codex`. Attach
   only `codex`. Then call `fabric_list_agents` and `fabric_list_workspaces` as
   the operator. There must be exactly one agent with exactly one Codex
   endpoint. Record `{{REVIEWER_WORKSPACE_ID}}`, `{{REVIEWER_AGENT_KEY}}` and
   `{{REVIEWER_CODEX_ENDPOINT_ID}}`. If the connect step does not create the
   agent or endpoint, create them with `fabric_create_agent` and
   `fabric_bind_local_endpoint` instead.
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
   placeholders too.]
5. **Stop the relay.** Stop the relay on the seed device and leave the device
   enrolled. Tasks that TC-5 dispatches then stay `offered` and expire. No new
   trajectory can appear, so TC-3 keeps returning exactly T1 to T5.
6. **Bundle for TC-7.** As the operator, create a signed clear baseline with
   `fabric_release_skill` (`mode` `clear_baseline`) and record its bundle ID as
   `{{REVIEWER_CANARY_BUNDLE_ID}}`. The developer reviewer is refused before
   the server reads the bundle, so TC-7 does not depend on its rollout state.
   To also run the guided admin rollback check, use instead a signed install
   bundle whose rollback ancestor is that baseline, started as a 10% canary
   with `fabric_rollout_start`.

## Acceptance before submission

1. Connect ChatGPT (developer mode) to `https://mcp.dharma-ai.io/mcp` as the
   reviewer account.
2. Run TC-1 to TC-7 and the three negative cases on ChatGPT web, then on
   ChatGPT mobile, with the substituted prompts.
3. Each result must match its expected output in `chatgpt-app-submission.json`.
   Fields the expected output does not name (timestamps, new task and session
   IDs, correlation IDs) may differ.
4. Capture `tools/list` with the reviewer session, project it with
   `scripts/mcp-tools-list-project.mjs`, and run
   `node scripts/verify-mcp-catalog.mjs --snapshot-manifest <manifest.json>`.
   The verdict must be `compatible`.
5. Repeat steps 2 and 3 after 48 hours with the relay still stopped, to show
   that the Codex endpoint stays `active` and TC-5 still returns `offered`.

If any result differs, fix the seed or the expected output in this repository
before submitting. Do not submit expected outputs that were not observed.

## Reset

| Created by a test run | Effect on other cases | Reset needed |
| --- | --- | --- |
| TC-5: one `offered` task per run | None. No case lists tasks. | No |
| TC-6: one conversation per run | None. No case lists conversations. | No |
| TC-4: one evidence read audit event per run | None | No |

Between OpenAI review rounds nothing needs resetting. If the seed is damaged
(for example the relay was restarted and new trajectories arrived, or another
agent was created), do not try to delete individual records. Rebuild the
reviewer organization from step 1 and record new placeholder values.
