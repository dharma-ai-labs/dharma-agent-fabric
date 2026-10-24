# CLI Command Contract

## Human and machine modes

There is one output mode. Each command prints one JSON document on stdout,
indented with two spaces. A string result, such as the usage text, is printed as
plain text. `signing-recovery` also streams compact JSON progress frames, one
per line. `--json` is accepted for compatibility and does not change the output.
Approval prompts, watch progress and other human-readable lines go to stderr.
Stdout contains no spinner, color, or diagnostic prose.

`--help` or `-h` anywhere on the command line prints the global usage summary.
There is no per-command help. A failed command prints its error message as
text on stderr; see [Exit codes](#exit-codes).

## Root commands

The list below is the CLI dispatch table. A contract test fails when a dispatched
command is missing here or a command listed here is not dispatched.

```text
dharma help
dharma version

dharma bootstrap
dharma onboard
dharma setup codex
dharma login
dharma status
dharma signing-recovery

dharma sessions start
dharma sessions status
dharma sessions readiness
dharma sessions work
dharma sessions stop
dharma sessions audit
dharma sessions quiesce
dharma sessions resume
dharma sessions reconcile-stopped-lock
dharma sessions serve

dharma demo connect
dharma demo transport-connect
dharma demo status
dharma demo package
dharma demo package-status
dharma demo watch
dharma demo watch-enable
dharma demo watch-status
dharma demo watch-disable
dharma demo role
dharma demo peers
dharma demo ask
dharma demo reply
dharma demo inbox
dharma demo ack
dharma demo resume
dharma demo signing-client-proof
dharma demo signing-owner-proof

dharma providers list

dharma repositories discover
dharma repositories connect
dharma repositories list
dharma repositories metadata
dharma repositories status
dharma repositories snapshot
dharma repositories recover-installer
dharma repositories source-resolve
dharma repositories restore
dharma repositories role-register
dharma repositories role-discover
dharma repositories ask
dharma repositories reply

dharma workspace add
dharma workspace sync
dharma workspace recover-registry

dharma evidence preview
dharma evidence capture
dharma evidence capture-batch
dharma evidence sync
dharma evidence run-request
dharma capture

dharma relay start
dharma relay stop
dharma relay probe
dharma relay upgrade
dharma relay autostart status
dharma relay autostart pause
dharma relay autostart disable
dharma relay container-entrypoint
dharma relay supervise

dharma assistant chat
dharma assistant history
dharma assistant status
dharma assistant approve
dharma assistant reject

dharma organization status
dharma agents list
dharma agents bind-runtime
dharma evaluations validate
dharma evaluations launch
dharma evaluations status
dharma evaluations results
dharma experiments list
dharma experiments run
dharma failures list
dharma remediations list
dharma remediations act
dharma usage list

dharma tasks list
dharma tasks dispatch
dharma tasks run-once
dharma handoffs list
dharma handoffs dispatch

dharma skills list
dharma skills release
dharma skills rollout
dharma skills rollback
dharma skills sync
dharma skills status
dharma skills verify
```

`help` and `version` behave like `--help` and `--version`. `capture` is an
alias of `evidence capture`. `sessions serve` and `relay supervise` are
internal entries: `sessions start` launches `sessions serve`, and `relay start`
and the owned startup entry launch `relay supervise`. The `--help` summary lists
most commands. `setup codex`, `repositories source-resolve` and
`repositories restore` are described in their own usage paragraphs, while
`sessions quiesce`, `sessions resume`, `tasks run-once` and `handoffs dispatch`
are dispatched but not listed there.

`logout`, `device`, `messages`, `policy` and `diagnostics` are not CLI commands,
and neither are `workspace list`, `inspect`, `pause`, `resume` or `remove`.
The CLI has no device revocation command; local diagnosis uses
`status --diagnostic` and `sessions readiness --diagnostic`.

The organization control-plane commands (`organization`, `agents`,
`evaluations`, `experiments`, `failures`, `remediations`, `usage`, `tasks list`,
`tasks dispatch`, `handoffs` and `skills list|release|rollout|rollback`) call the
organization API for `--organization-id` or the enrolled organization. They use
`DHARMA_ORG_API_TOKEN` when it is set and the device-scoped organization token
otherwise. Every mutating control-plane command requires `--confirm`.

## Setup and enrollment

```text
dharma bootstrap --setup-reference <public-reference> --setup-recipient-membership-id <membership> --setup-scope-digest <sha256> --setup-contract-digest <sha256> --complete
dharma login --portal-url <origin> --organization-id <organization-id>
dharma status --verbose
```

`bootstrap` with a setup reference is the agent setup route; it runs inside the
coding agent and the recipient approves the exact device in the browser.
`login` is the manual first-enrollment route and requires an explicit
organization for a new device. One `DHARMA_HOME` serves one organization:
`login` refuses a home that is enrolled to, or holds workspaces of, another
organization. `setup codex` is the Linux named-Codex setup entry. The exact
options for each route are in the `--help` summary.

## Named Session Maintenance

`sessions quiesce` and `sessions resume` are not listed in the `--help` summary.
Like every `sessions` command outside the bootstrap setup callback, these
commands run only on Linux and fail elsewhere with
`codex_session_sandbox_unqualified`. Named sessions are Codex sessions. The
commands require a capable client and running service:

```text
dharma sessions quiesce --name <name> --workspace-id <id> --fence-id <uuid> --apply
dharma sessions resume --name <name> --workspace-id <id> --fence-id <uuid> --apply
dharma sessions resume --name <name> --workspace-id <id> --fence-id <uuid> --recover-stopped --apply
dharma sessions start --name <name> --workspace-id <id> --fence-id <uuid> --apply
dharma sessions stop --name <name> --workspace-id <id> --fence-id <uuid> --drained --apply
```

Without `--apply`, these commands plan only. Quiescence rejects new work and inbox
polls while already admitted operations and their evidence finish. A successful
receipt binds zero pending work to the exact session and process generation.
Only the matching fence can resume or stop that drained owner. Fences do not
expire automatically; a service restart invalidates an old generation's receipt.
Quiescence durably disables automatic session registration and verifies readback
before acknowledging its fence. Drained stop verifies that pause before shutdown.
Failed persistence leaves a recoverable quiesced service; matching resume verifies
the enabled registration before reopening admission. Automatic supervisors cannot
reenable a disabled registration, including after a crash or a stale startup poll.
The persisted maintenance marker also blocks ordinary `start` when live status
is unavailable. Explicit `resume --recover-stopped` requires the matching fence,
a confirmed stopped owner, unchanged registration, and the same unexpired
protected provider binding. It leaves automatic registration disabled, marking
only restart permission. A subsequent explicit `start` must supply the matching
fence and confirm the old owner is still stopped before enabling startup. Its
receipt is not runtime readiness, and interrupted work remains retained.
An unsupported service is rejected before a control request. Legacy `stop`
can interrupt work and is not proof of a drained boundary. These commands neither
change enrollment nor authorize an upgrade or additional provider work.

## Workspace

```text
dharma workspace add <path> --organization-id <id> --json
dharma workspace sync <workspace-id> --policy-revision <revision> --apply
dharma workspace recover-registry --workspace . --dry-run
```

`workspace add` writes only the local workspace registry; `--organization-id`
must match the enrolled device. `workspace sync` plans without `--apply`; with
`--apply` it registers the workspace with Dharma through the device-signed
client and binds it to its repository agent. `repositories connect`, `onboard`
and `bootstrap` perform the same registration. Signed registration applies the
server policy revision to `.dharma/approved-policy.json`; no command broadens
organization policy locally.

## Providers

```text
dharma providers list --json
```

This handler inspects local provider capabilities and protected action-decision
receiver prerequisites. It can read enrollment/trust state and self-test the local
execution journal; it is not a no-effect metadata-only command. It does not select
a workspace, establish a repository-to-endpoint binding, attach an active provider
conversation, or prove useful task delivery. `providers probe` and `providers smoke`
are not implemented CLI commands in this release.

## Evidence

```text
dharma evidence preview --workspace <path> --provider <id> --policy <approved-policy.json> --maximum-sessions <n> --json
dharma evidence capture --workspace <path> --provider <id> --policy <approved-policy.json> --json
dharma evidence capture-batch --workspace <path> --provider <id> --policy <approved-policy.json> --maximum-sessions <n> --sync
dharma workspace sync <id> --policy-revision <revision> --apply
dharma evidence sync --file <capsule.json> --workspace-id <id> --policy <path> --json
dharma evidence run-request --policy <policy.json> --workspace-id <id> --json
```

`preview` requires `--workspace` and `--provider`; with `--policy` it also
reports the policy-qualified disclosure for a locally registered workspace.
`capture` and `capture-batch` require `--workspace`, `--provider` and
`--policy`. Batch capture also requires `--maximum-sessions` or
`--session-ids-file`. `evidence capture --assignment-id <UUID>` is a
selection-only route for qualified in-process owner hosts; the standalone CLI
has no reader for it and refuses with `capture_source_unavailable`. There are no
`evidence sources`, `disclosures` or `export-local` commands.

## Tasks

```text
dharma tasks list --json
dharma tasks dispatch --body-file <task-request.json> --confirm --json
dharma tasks run-once --policy <approved-policy.json> --workspace-id <id> --json
```

`list` reads the selected organization's task list; listing does not accept or
execute a task. `dispatch` submits a request through the organization API and
requires `--confirm` after reviewing scope, cost and authority. The request file
contains the authorized task request, not provider credentials or an enrollment
grant. Confirmation does not replace signed task, target, policy or budget checks.

`run-once` is an execution command, not a routing diagnostic. It requires the
canonical verified policy of a locally registered workspace, can reconcile
previously retained task trajectories, and can execute offered work. Do not run it
merely to discover whether a provider connection works. Server-offered tasks can
auto-accept only when every authority requirement is pre-approved by local policy.

`tasks inspect`, `accept`, `reject`, `send` and `cancel` are not implemented public
CLI handlers in this release. Do not use proposed spellings as acceptance or
rejection controls. Authentication, task enqueue, receipt, provider execution and
explicit integration acceptance are separate evidence states.

## Handoffs and questions

```text
dharma handoffs list
dharma handoffs dispatch --body-file <handoff-request.json> --confirm
dharma repositories ask --workspace-id <id> --category <category> --question <text>
dharma repositories reply --workspace-id <id> --question-id <id>
dharma demo inbox --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote>
```

There is no `messages` command. `handoffs dispatch` submits an A2A handoff
through the organization API and requires `--confirm`. `repositories ask` sends
a bounded question from a registered workspace, and `repositories reply` reads
the reply to a question by its ID. Both are pulls by the caller. With
`--session-name`, they go through a named session, so they are Linux and Codex
only. `demo` peer commands use a separate Demo device and repository scope. No
command attaches to an existing provider chat or delivers into it. For Claude
Code, a relay task runs as a new `claude --print --no-session-persistence`
process in a relay-owned worktree; see
[provider-session routing](24-provider-session-routing.md).

## Skills

```text
dharma skills status --workspace-id <id> --provider <codex|claude|agy|hermes>
dharma skills verify --provider <codex|claude|agy|hermes> --workspace <path>
dharma skills sync --workspace-id <id> --provider <codex|claude|agy|hermes> --policy <path>
dharma skills list
dharma skills release --body-file <release.json> --confirm
dharma skills rollout --bundle-id <id> --confirm
dharma skills rollback --bundle-id <id> --confirm
```

`skills verify` checks both the repository-scoped Skill and the provider-native managed bootstrap. Its `ready` field means that the generic bootstrap is installed and discoverable; it does not attest an active signed remediation bundle. Agy and Hermes use provider-native activation checks before the device signs an active receipt: Agy returns the signed bundle token through its plugin interface, while Hermes must trust the repository and report every signed Skill identifier through `hermes skills list --source local --enabled-only`. `skills sync` polls for an approved, signed rollout and installs it with a receipt only for providers whose lifecycle capability supports that operation. Active bundle state is workspace-scoped, so one provider installation can retain independently reversible releases for several connected repositories. `skills list`, `release`, `rollout` and `rollback` are organization control-plane requests: `release`, `rollout` and `rollback` require `--confirm`, and `rollout` and `rollback` take the exact `--bundle-id`. They do not install or remove a bundle on this device; `skills sync` does that from a signed rollout. Bundle inspection and planning remain dashboard operations.

## Relay

```text
dharma relay start --policy .dharma/approved-policy.json
dharma relay stop
dharma relay probe
dharma relay autostart status
dharma relay autostart pause --apply
dharma relay autostart disable
dharma relay upgrade --workspace <owned-checkout> --apply
dharma relay container-entrypoint
dharma status
```

`relay upgrade` plans an upgrade of the owned relay runtime for a registered
checkout and applies it only with `--apply`. Except with `--rollback`, it refuses
while the owned relay, supervisor or a named session is running.
`relay autostart pause` works only with the container-entrypoint startup
backend and plans without `--apply`. `relay container-entrypoint` is the
non-root Linux PID 1 entry for an owned container; see the CLI README.

Complete bootstrap starts the registered supervisor and configures per-user startup on Windows, Linux with a systemd user session, or macOS with the recipient's graphical login session. Linux Codex bootstrap preserves the selected nondefault `CODEX_HOME` location in its owned startup receipt, without copying credentials or importing arbitrary environment variables. Linux relay recovery uses that registered service instead of starting a competing detached supervisor. `relay start` is a foreground receiver; `relay stop` gracefully stops the current supervisor and receiver without deleting enrolled identity or vault data. The startup entry remains for the next user sign-in until `relay autostart disable` removes it. `status` reports startup registration and the last successful relay poll; `relay probe` independently checks the signed connection. Unavailable user-session startup is an incomplete bootstrap stage. Registration is not native reboot, protected-store recovery or signed skill activation proof; macOS qualification remains required.

## Exit codes

Only three codes are emitted:

- `0`: the command returned its result. A returned receipt can still report a
  blocked or failed stage; read it.
- `1`: `bootstrap` or `setup codex` returned a receipt without `ok: true`; or
  `setup codex`, other than its dry-run plan, or `bootstrap --complete`, other
  than a `--setup-reference --dry-run` plan, did not reach `stage: "complete"`
  with `sharedRepositoryReady: true`. `1` is also returned when no supported
  Node.js runtime is available.
- `2`: the command threw: an unsupported command, invalid arguments, a refused
  precondition, or an authentication, network, policy or signature failure.
  `signing-recovery`, `sessions readiness --diagnostic` and the
  `relay upgrade` signing-maintenance stages also exit `2` when their receipt is
  not the expected success receipt.

Codes `3` to `8` are not used. Errors are not wrapped in a JSON envelope: the
message is printed as text on stderr. When the CLI relaunches itself under a
supported Node.js runtime, it exits with that process's code.
