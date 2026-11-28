# Task Execution and Agent-to-Agent Communication

## Task execution objective

The Dharma orchestrator must be able to assign bounded engineering work to any compatible local or managed agent while preserving repository isolation, provider independence, evidence lineage, cost attribution, and explicit authority.

## Task state machine

```mermaid
stateDiagram-v2
  [*] --> proposed
  proposed --> offered
  offered --> accepted
  offered --> rejected
  accepted --> preparing
  preparing --> running
  preparing --> failed
  running --> waiting_for_input
  waiting_for_input --> running
  running --> validating
  validating --> completed
  validating --> failed
  running --> cancelling
  cancelling --> cancelled
  running --> lease_expired
  waiting_for_input --> lease_expired
  completed --> [*]
  failed --> [*]
  rejected --> [*]
  cancelled --> [*]
  lease_expired --> [*]
```

Every transition is idempotent and recorded as an event.

## TaskEnvelope

A task includes:

- organization and workspace;
- target device or selector;
- required provider capability;
- exact instruction;
- pinned skill bundle;
- evidence policy;
- read and write path policy;
- approved commands or command classes;
- network policy;
- Git behavior;
- timeout and lease;
- concurrency;
- acceptance commands;
- required artifacts;
- model execution and billing mode;
- human confirmation requirements;
- signature and expiry.

The server may select a device through a selector, but the final signed offer names the exact device and workspace.

## Default authority

A standard remote task may:

- read the registered repository;
- create an isolated Git worktree;
- modify approved repository paths;
- run approved repository commands;
- use the selected local provider's existing authentication;
- commit changes;
- push a task branch to an approved remote;
- produce evidence and artifacts.

It may not by default:

- read outside the registered workspace;
- use arbitrary user-home files;
- access unrelated repositories;
- open unrestricted network connections;
- merge to the default branch;
- modify protected branches;
- deploy;
- rotate production secrets;
- broaden its own command or path policy;
- install a new global tool without an approved dependency policy.

## Worktree lifecycle

1. Verify clean Git identity and remote.
2. Fetch the approved base ref.
3. Create `dharma/task/<task-id>`.
4. Create a worktree below the relay task directory, not inside the active developer workspace.
5. Materialize the pinned skill bundle for the task.
6. Record base commit, worktree path, provider version, policy revision, and skill bundle.
7. Start the provider through its task adapter.
8. Stream normalized events and bounded progress.
9. Run acceptance commands after the provider stops, each inside an operating-system sandbox. A task that names registered commands (`authority.commands` or `acceptance.commands`) runs only on Linux or WSL2 with a usable bubblewrap sandbox and network authority `deny`. The local relay checks this right after it polls the task, with a live sandbox probe for that task. Otherwise it posts one terminal `failed` event with `{phase: 'preflight', code: 'registered_commands_refused', reason}`, never posts `started`, and keeps polling; the task runner refuses the same tasks before step 1. The provider gets no command tools for such a task. The sandbox shows the command only read-only system folders, the relay's Node binary and npm package and the task worktree (the only writable folder), with no network, an empty home and temporary folder, and no other processes. The relay reads the commands the task names from the approved policy once, when it admits the task, and hands the task runner a frozen copy; every command lookup, before and after the provider, reads only that copy, so a policy file the provider rewrites during the task changes nothing for that task. A `remediation_smoke` task passes the same admission and sandbox, and no task starts a skill smoke check. See the task-runner package README for the reasons, fix lines and limits.
10. Commit only when policy and task require it.
11. Push only the task branch.
12. Preserve or delete the worktree according to result and retention policy.
13. Return a final evidence manifest.

## Provider task adapter interface

```ts
export interface ProviderTaskAdapter {
  readonly providerId: string;
  probe(context: ProbeContext): Promise<ProviderCapabilityReport>;
  prepare(request: PrepareTaskRequest): Promise<PreparedProviderTask>;
  start(task: PreparedProviderTask): AsyncIterable<ProviderRuntimeEvent>;
  sendMessage(taskId: string, message: AgentInputMessage): Promise<void>;
  cancel(taskId: string, reason: string): Promise<CancelResult>;
  collectFinal(taskId: string): Promise<ProviderTaskResult>;
}
```

A provider implementation must pin and test the installed host version or version range. Do not copy another provider's command invocation by analogy.

For Claude Code on Vertex AI, authenticate the host with Google Application Default Credentials and configure the execution shell explicitly:

```bash
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=<customer-project-id>
export CLOUD_ML_REGION=global
export DHARMA_CLAUDE_MODEL=claude-sonnet-5
```

`DHARMA_CLAUDE_MODEL` is passed as a single validated `claude --model` argument and is included in the execution setup rather than inferred from a mutable Claude default. Provider credentials remain local to the device.

## Command policy

A task does not receive unrestricted shell text. It receives one of:

1. An exact command approved in workspace policy.
2. A named command from the repository command registry.
3. A bounded tool action implemented by the task runner.

Example workspace registry:

```yaml
commands:
  test:
    argv: [npm, test]
    timeout_seconds: 1200
  lint:
    argv: [npm, run, lint]
    timeout_seconds: 600
  typecheck:
    argv: [npm, run, typecheck]
    timeout_seconds: 600
```

The provider may propose a new command, but the relay must request approval or reject it according to policy.

Registered acceptance commands run with an explicit environment: operating-system essentials, the variable names their approved policy entry lists under `environment.inherit`, and the runner-owned names. They do not receive the whole relay environment. This keeps relay variables out of the command's own environment and output. The allowlist is not the isolation boundary; the operating-system sandbox in step 9 is. Inside it, the command sees no other processes, so this explicit environment is the only environment it can read. Paths that do not run inside the sandbox, such as the provider process and skill smoke checks, can still read the relay process environment through the operating system. Relay-internal Git calls run with the same essentials. The worktree is created with the operator's normal Git configuration, before any task code runs; every later call runs from a relay-owned folder with system and global Git configuration turned off and `HOME` and `XDG_CONFIG_HOME` naming a relay-owned empty folder, apart from the operator's checkout settings and global exclude file read before the task. They use a relay-owned empty hooks folder, read attributes from the task's starting commit, never look inside submodule folders, use repository paths pinned when the worktree was created, and fail the task closed (`relay_git_isolation_failed`) if the `.git` pointer, a program-relevant repository configuration entry, the Git-directory attributes or exclude files, or a `.gitignore` that could hide writes outside the write paths changes during the task. See the task runner package guide for the per-platform list, the limits on inherited names and the paths that still inherit the relay environment.

## Network policy

Modes:

- `deny`
- `package_registry_only`
- `allowlisted_domains`
- `inherit_local_provider`

The initial default for server-initiated tasks is `deny`, except for the provider's native authenticated service and the approved Git remote. Dependency installation requires explicit policy.

## Streaming evidence

Task progress should transmit:

- lifecycle transitions;
- user-visible agent messages;
- tool names and bounded arguments;
- command start and result summaries;
- file mutation summaries;
- validation results;
- permission requests;
- errors and retries;
- A2A messages;
- cost or usage evidence when available.

Do not stream full command output repeatedly. Store locally and upload selected or requested spans.

## Human interaction

The task may enter `waiting_for_input` when:

- a product decision is genuinely unresolved;
- new authority is required;
- the provider asks a question;
- a secret or credential must be supplied through an approved channel;
- acceptance evidence conflicts.

The server or a human can reply through an `AgentMessage`. The reply becomes part of the task trajectory.

## Agent-to-agent protocol

An `AgentMessage` contains:

- organization;
- conversation and task;
- source and target agent identities;
- source and target environments;
- prose content;
- structured state;
- evidence references;
- requested response type;
- authority;
- delivery expiry;
- budget;
- signature.

### Example structured handoff

```json
{
  "status": "blocked",
  "failedGates": ["heic_integration_test", "visual_diff_threshold"],
  "missingAuthority": ["engineering_owner_approval"],
  "permittedActions": ["inspect_failure", "prepare_patch", "rerun_tests"],
  "forbiddenActions": ["deploy", "tell_customer_resolved"],
  "requiredRecovery": [
    "fix orientation regression",
    "pass integration and visual tests",
    "obtain engineering owner approval"
  ]
}
```

The receiving agent must not infer authority from prose when structured authority is present.

## Routing

The broker can target:

- a specific agent instance;
- any online agent with a provider capability;
- a team or workspace queue;
- a managed environment;
- a human approval queue.

Routing decisions preserve why the target was chosen.

## Offline delivery

- Messages use durable leases.
- A target may accept after reconnect if the message has not expired.
- Task-critical messages receive delivery and application acknowledgements.
- The orchestrator may reroute only when the message contract allows it.

## Speculative execution

Do not enable by default. When explicitly enabled, multiple agents may receive the same read-only or isolated task. Their branches and trajectories remain separate. A separate selector compares results. No agent may see another candidate before its own output freezes unless the task is designed as collaboration.

## Completion evidence

A completed task returns:

- final state;
- base and final commit;
- task branch;
- diff summary and hash;
- acceptance command results;
- provider and model metadata;
- pinned skill bundle;
- trajectory capsule IDs;
- unresolved issues;
- cost evidence;
- artifact manifest;
- local and server receipts.
