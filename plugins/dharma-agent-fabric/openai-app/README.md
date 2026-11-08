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

The hosted server registers 65 tools. Every authenticated client other than
ChatGPT sees all 65; a ChatGPT connection sees only the 20-tool ChatGPT profile
described below. `live-mcp-tools.snapshot.json` records them exactly as the server
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

Owner decision (Nick, 2026-10-31): ship a server-side filter keyed to the ChatGPT OAuth
client in the HQ control plane, so ChatGPT is served only the declared profile.
AGENTS.md stays unchanged.

The filter is live in production since platform #1909 (merge commit
`724df4d7`, 2026-11-08). For a ChatGPT OAuth client, `tools/list` returns only
the 20 profile tools and a call to any other tool is refused; if the server
cannot tell which client it is serving, it returns an error rather than the
full list. Other clients still see all 65 tools. The filter is a platform
change and is not part of this package. With it live, the platform condition
for submission is met; the submission itself is still the owner's action.

## Keeping the package in step with the server

- `npm run mcp:catalog:verify` checks that the catalog and the test cases
  match `live-mcp-tools.snapshot.json`, and that the submission declares
  exactly the ChatGPT profile.
- Before each submission, capture `tools/list` from the hosted server with a
  non-ChatGPT MCP client (for example MCP Inspector or `curl`) signed in as the
  reviewer account. Save the `result` object of the `tools/list` response (not
  the JSON-RPC envelope) as `tools-list.json`, set `SERVER_NAME` and
  `SERVER_VERSION` to `serverInfo.name` and `serverInfo.version` from the
  `initialize` result of the same session, and run the full comparison without
  `--profile`, from the repository root in a POSIX shell (Git Bash on
  Windows):

  ```sh
  node scripts/mcp-tools-list-project.mjs --stdin --identity "$SERVER_NAME" --version "$SERVER_VERSION" < tools-list.json > server-snapshot.json
  node scripts/mcp-snapshot-manifest-assemble.mjs --expected-identity "$SERVER_NAME" --expected-version "$SERVER_VERSION" --snapshot server-snapshot.json > manifest.json
  node scripts/verify-mcp-catalog.mjs --snapshot-manifest manifest.json
  ```

  One `server` capture cannot be `compatible`: `tools/list` carries no
  confirmation flag, and the other four boundaries are not supplied. So the
  verifier exits 1, the verdict must be `unknown`, and the capture passes only
  when `manifestErrors` is empty, the `server` boundary's `missingTools` and
  `extraTools` are both empty (all 65 tools), its reasons are only
  `confirmation_evidence_missing` and `schema_reference_missing` or
  `schema_unsupported` (the hosted server labels its schemas JSON Schema
  draft-07), so there is no `annotation_mismatch`, and each other boundary is
  `unknown` with the single reason `not_supplied`. Do not add confirmation
  values, or source, host, submitted or released snapshots, that nobody
  observed. ChatGPT developer mode never shows the raw `tools/list`, so the
  ChatGPT side is checked there: the connector lists exactly the 20 tools
  marked `chatgptProfile: true` in `mcp-tool-catalog.json`, and when asked to
  call a tool outside the profile, ChatGPT does not offer the tool and the
  conversation shows no `tools/call` to it (`REVIEWER_SEED_PLAN.md`,
  acceptance step 4). The server-side refusal (the tool is disabled for a
  ChatGPT client, and the route guard answers `tool_not_in_client_profile`) is
  covered by the platform tests `src/app/mcp/chatgptToolProfile.test.ts` and
  `src/lib/agent-fabric/chatgptToolProfile.test.ts` in
  `dharma-ai-labs/dharma-ai-platform`, not by this manual step.
  `--profile chatgpt` is only for a capture that really came through a
  ChatGPT-registered OAuth client (one registered dynamically with every
  redirect URI on `https://chatgpt.com`); the usual operator cannot make one.
  Such a capture is checked against the 20-tool profile by replacing the last
  command with
  `node scripts/verify-mcp-catalog.mjs --snapshot-manifest manifest.json --profile chatgpt`,
  against the same criterion. Refresh `live-mcp-tools.snapshot.json` only when
  a non-ChatGPT capture fails this criterion with `missing_tools`,
  `extra_tools` or `annotation_mismatch`. Never refresh the 65-tool snapshot
  from a ChatGPT-client capture.
- Test cases and their seed are described in `REVIEWER_GUIDE.md` and
  `REVIEWER_SEED_PLAN.md`.

## Publication

The endpoint and local contract are implemented. The app remains submitted/in
review until OpenAI confirms directory approval; developer or reviewer access
does not establish public Store availability.
