# Dharma Agent Fabric Remote App

The public plugin Skill should connect to a remote Dharma app implemented with MCP and the OpenAI Apps SDK.

The app authenticates the user to Dharma and exposes organization-level intent tools. It never connects directly to localhost and never receives device private keys.

## Implemented server contract

- Clerk OAuth with dynamic client registration.
- Active Dharma organization membership enforcement on every invocation.
- Tool-level Zod input contracts. Every tool requires an explicit
  `organizationId`.
- Idempotency for every mutation.
- Explicit confirmation (`confirmed: true`) for sensitive evidence and every
  mutation.
- Existing platform audit, billing, KMS, rate-limit, and capability enforcement.
- Role enforcement: `developer` members can read and run bounded work;
  organization admins alone can use rollout, remediation, learning-policy and
  control-agent execution tools.

## Tool surface

The hosted server exposes 65 tools to every authenticated client, ChatGPT
included. `live-mcp-tools.snapshot.json` records them exactly as the server
registers them: names, titles, descriptions, annotations, confirmation and
required inputs. `mcp-tool-catalog.json` adds the backend scope, admin-only flag,
mode and ChatGPT profile flag for each tool. `chatgpt-app-submission.json`
declares only the ChatGPT profile described below.

| Group | Tools | Who |
| --- | --- | --- |
| Identity, devices, agents, workspaces, instructions | 6 reads | members (`fabric_list_workspaces`: admins) |
| Agent and endpoint setup | `fabric_create_agent`, `fabric_bind_local_endpoint`, `fabric_bind_runtime_endpoint` | members with run scope |
| Trajectories and evidence | 2 reads, `fabric_request_trajectory_evidence` | members |
| Failure Atlas, remediations, evaluations, usage, tasks, A2A, skills | 7 reads | members |
| Bounded work | `fabric_dispatch_task`, `fabric_dispatch_a2a`, `fabric_run_analysis` | members with run scope |
| Learning policies | 3 reads, 3 admin writes | admins for writes |
| Skill release and rollout | `fabric_release_skill`, `fabric_rollout_start`, `fabric_rollout_expand`, `fabric_rollout_rollback` | admins |
| Remediation lifecycle | 11 `fabric_remediation_*` tools, including `fabric_remediation_merge_pr` | admins |
| Organization control agent | 4 session tools, 8 `fabric_control_read_*` reads, 9 `fabric_control_execute_*` tools, `fabric_control_reject_proposal` | reads for members; execution and rejection for admins |

What the server does not expose:

- arbitrary shell, local file reads or unbounded evidence upload;
- free-form agent chat outside a task or control-agent session;
- a generic merge: `fabric_remediation_merge_pr` merges only the exact approved
  remediation pull request, for an organization admin, without bypassing a
  failed check;
- a generic deployment: release and rollout tools change signed skill
  installations on the organization's own endpoints and runtimes, and nothing
  else;
- secret or credential retrieval;
- role or membership changes.

Control-agent proposals for paid or mutating work are only recorded when the
agent proposes them. An organization admin runs one exact proposal with the
matching `fabric_control_execute_*` tool, which checks the stored arguments
hash, or rejects it with `fabric_control_reject_proposal`.

## ChatGPT tool profile

`AGENTS.md` sets the security default "No direct merge or deployment
authority". The ChatGPT app therefore declares a 20-tool profile, marked with
`chatgptProfile: true` in the catalog: 17 reads, `fabric_dispatch_task`,
`fabric_control_agent_create_session` and `fabric_control_agent_send_message`.
It leaves out the remediation lifecycle (including `fabric_remediation_merge_pr`),
skill release and every rollout tool (including `fabric_rollout_rollback`),
learning-policy administration, control-agent execution, endpoint binding and
evidence-request writes. `npm run mcp:catalog:verify` fails if the submission
declares any other tool, or if the profile gains a merge, release or rollout
tool. All submitted test cases use only read-only profile tools.

The declared profile is not yet what ChatGPT sees. Today the server lists all
65 tools to every client and cannot show ChatGPT fewer tools than other
clients.

[NICK-DECIDES: either ship a server-side filter keyed to the ChatGPT OAuth
client in the HQ control plane, so ChatGPT is served only the declared profile,
or amend AGENTS.md to allow the admin-only merge and signed rollout tools in
the ChatGPT app. Until one of them is done, the package must not be submitted.
This package does not amend AGENTS.md.]

## Keeping the package in step with the server

- `npm run mcp:catalog:verify` checks that the catalog and the test cases
  match `live-mcp-tools.snapshot.json`, and that the submission declares
  exactly the ChatGPT profile.
- Before each submission, capture `tools/list` from the hosted server, project
  it with `scripts/mcp-tools-list-project.mjs`, and run
  `node scripts/verify-mcp-catalog.mjs --snapshot-manifest <manifest.json>`.
  Refresh the snapshot if the verdict is not `compatible`.
- Test cases and their seed are described in `REVIEWER_GUIDE.md` and
  `REVIEWER_SEED_PLAN.md`.

## Publication

The endpoint and local contract are implemented. The app remains submitted/in
review until OpenAI confirms directory approval; developer or reviewer access
does not establish public Store availability.
