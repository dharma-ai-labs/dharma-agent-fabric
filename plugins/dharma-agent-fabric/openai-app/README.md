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
required inputs. `mcp-tool-catalog.json` adds the backend scope, admin-only flag
and mode for each tool. `chatgpt-app-submission.json` declares the same 65
tools, because OpenAI reads the tool list from the server.

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

## Proposed ChatGPT profile

[NICK-DECIDES: whether the ChatGPT app should see a smaller tool set. Today the
server cannot show ChatGPT fewer tools than other clients. A smaller set needs
a server-side filter keyed to the ChatGPT OAuth client, in the HQ control
plane. Until that ships, the submission must declare all 65 tools.]

The catalog marks a proposed 21-tool profile with `chatgptProfile: true`:
17 reads, `fabric_dispatch_task`, `fabric_control_agent_create_session`,
`fabric_control_agent_send_message` and `fabric_rollout_rollback`. It leaves
out learning-policy administration, the remediation lifecycle (including the
merge tool), control-agent execution, endpoint binding, skill release and
evidence-request writes. All submitted test cases use only profile tools.

## Keeping the package in step with the server

- `npm run mcp:catalog:verify` checks that the catalog, the submission tool
  declarations and the test cases match `live-mcp-tools.snapshot.json`.
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
