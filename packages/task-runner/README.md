# `@dharma-ai-labs/agent-fabric-task-runner`

Local callers may opt into adapter-boundary digest receipts with
`executeTask({ providerQualification, ... })`. Its declared organization/task
must match the already signed task; the option adds no execution authority or
new acceptance gate. It is forwarded to the existing provider executor and the
returned qualification is retained in that provider command's stored result.
A bounded data-only report must match the declaration, signed target provider and outcome;
extra raw fields, accessors and mismatched reports are discarded, not persisted.
An executor report remains a report, not an independent attestation.
A custom executor that does not report valid qualification produces an explicit
`qualificationReceipt: null`, without converting ordinary task success into
qualification success. Existing completed-task replay returns the original
receipt, not a newly labelled observation. The option is not a new signed-task
field, an independent oracle, a context-isolation guarantee or runtime evidence
of the effective model/settings. Omission leaves legacy receipts unchanged.

Signed, leased, policy-bound execution for local Agent Fabric tasks. Tasks run
in relay-owned Git worktrees using registered command IDs and canonical
arguments under explicit path, network, Git, budget, and Skill-pin authority.
It is not a general remote shell.

## Tasks that name registered commands are refused

Registered commands, meaning acceptance commands and, for Claude tasks, the same
commands offered to the provider as Bash tools, would run as the relay's
operating-system user without a sandbox. Code written during the task could then
read that user's credential files. Until command isolation exists, `executeTask()`
refuses every task with a non-empty `authority.commands` or
`acceptance.commands`.

The refusal happens after signature, expiry and organization checks and before
any worktree, provider process or command starts. `executeTask()` throws
`RegisteredCommandsRefusedError`, whose `code` is
`registered_commands_refused` (exported as `REGISTERED_COMMANDS_REFUSED`). No
task receipt is written, so nothing claims the task ran. A task that was already
completed and has a stored receipt still returns that receipt. Network-authorized
receipt-required tasks need an external-effect receipt command, so they are
refused too.

The local relay checks the same condition first, with the exported
`taskNamesRegisteredCommands()` predicate, right after it polls the task and
before it syncs policy, takes the skill activation lock or posts `started`. It
posts one terminal `failed` task event with
`{ phase: 'preflight', code: 'registered_commands_refused' }` and keeps polling.
The `executeTask()` check stays as a backstop.

There is no opt-in. The only local policy file, `.dharma/approved-policy.json`,
lives in the workspace directory, so a repository change could carry a switch
there and turn the commands back on without the operator.

Tasks that name no registered commands run exactly as before. The provider gets
no command tools.

The sections below describe the command path that the isolation work will
re-enable.

## Receipt-required tasks

A signed task opts into action-time authorization with
`requiredCapabilities: ["action_decision_receipts_v1"]` and a UUID
`target.endpointId`. HQ embeds exactly one task-level decision as
`actionDecision: { id, actionDigest, receipt, signature, keyVersion }` in the
signed task. `executeTask()` verifies and consumes that decision immediately
before provider or acceptance execution. Missing, expired, mismatched,
unknown-key, replayed, or non-release receipts fail closed before any effect.

The default `FileActionDecisionReplayGuard` atomically consumes each decision ID
once under the relay state directory. A gated task receipt includes one HQ
enforcement acknowledgement: `executed` after complete execution, `unknown`
after an indeterminate release attempt, or `contained` for a valid non-release.
Tasks that omit the capability retain the previous behavior and receipt shape.

## Required Artifacts

`acceptance.requiredArtifacts` names workspace-relative regular files that must
be present and readable after the provider and registered acceptance commands,
before the runner records completion. References use `/` separators, must be
within signed read authority, and cannot contain traversal, empty segments,
wildcards, Windows device names or ambiguous platform-specific aliases.
Invalid or unauthorized references are rejected before provider execution.
The signed required-file list is included as data in provider instructions;
callers do not have to repeat it in their natural-language request.

Artifact sets use conservative portable names: distinct entries cannot collide
after NFC normalization and Unicode lower/upper/lower mapping, even on
case-sensitive hosts. This catches final-sigma and sharp-S aliases; it is a
conservative admission rule, not an exact implementation of every filesystem's
Unicode version. Both signed envelope schemas cap raw entries at 100 and each
reference at 1,000 Unicode characters. Bounded exact duplicates remain compatible
and are deduplicated; they still count toward the raw-entry cap.
Acceptance commands are capped at 98, reserving the 100-result receipt capacity
for one provider result and one late runner failure. Excess commands are rejected
before effects, rather than losing the durable failure receipt.
Windows device-name restrictions include
the superscript COM/LPT aliases and CONIN$/CONOUT$. Ill-formed Unicode (lone
surrogates) is rejected rather than replaced during filesystem encoding.
Components are limited to 255 UTF-8 bytes.
Resolved paths are limited to 259 UTF-16 units on Windows (without changing
long-path settings), 1023 UTF-8 bytes on macOS and 4095 on Linux. These supported
runner limits do not establish every filesystem or registered tool's limits.

Generated artifact metadata has its own 256,000 UTF-16-unit hard bound, separate
from the existing 20,000-unit task/context instruction limit. This accommodates
the schema's 100 paths of up to 1,000 characters without consuming task text's
allowance. Neither instructions nor signed paths are truncated; provider and
task budget enforcement still applies. Empty lists add no metadata.
Agy/Hermes carry text in argv and fail before process invocation if the complete
argument estimate exceeds 32,760 conservatively quoted UTF-16 units on Windows
or 65,536 UTF-8 bytes elsewhere. Codex/Claude use stdin. These supported limits
do not attest provider acceptance or all operating-system environment limits.

Missing, unreadable, non-file, symbolic-link/junction or hard-linked artifacts
fail acceptance. Artifact contents and target paths are not copied into failure
messages. Empty regular files satisfy presence, not quality; an empty required
list preserves existing behavior. A late failure after released work retains an
`unknown` action acknowledgement rather than claiming containment or execution.

Required paths without signed write authority must already exist before the
provider starts. The runner fingerprints their regular-file metadata and hashes
their contents without exposing either, then checks them after the provider and
after acceptance commands. Ignored files do not gain write authority from being
required artifacts. Write-authorized outputs still use final presence checks.
Git path inventories must be complete and NUL-terminated; exceeding the bounded
capture limit fails closed rather than authorizing a partial inventory.
The same signed write-path check runs after the provider and after each
acceptance command, including committed and untracked changes. A command's
registration does not expand path authority. A violation prevents subsequent
acceptance commands and successful completion; a released action retains an
`unknown` acknowledgement. Read-only required-file integrity is also checked
between commands, not only at the end.

This is a final-state completion check, not an OS sandbox, immutable artifact
snapshot, quality grader or proof of external effects. The integrity checks do not prevent all
concurrent filesystem mutation; native containment and independent acceptance
remain separate requirements.

## Acceptance command environment

Registered acceptance commands run with an explicit environment built for each
command, not the whole relay process environment. It is built in three steps:

1. Operating-system essentials are copied from the relay environment when present.
   - Windows: `PATH` (one key, matched case-insensitively and kept in its
     original casing, usually `Path`), `PATHEXT`, `SystemRoot`, `windir`,
     `ComSpec`, `SystemDrive`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`,
     `LOCALAPPDATA`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`,
     `ProgramData`, `CommonProgramFiles`, `NUMBER_OF_PROCESSORS`,
     `PROCESSOR_ARCHITECTURE` and `OS`.
   - Linux, WSL and macOS: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LANGUAGE`,
     `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_COLLATE`, `LC_NUMERIC`,
     `LC_TIME`, `LC_MONETARY`, `TZ`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME` and
     `XDG_CACHE_HOME`.
2. Names listed in the command's approved policy entry are copied for that
   command only (see below).
3. Runner-owned names are set last: `DHARMA_TASK_WORKTREE` is the command's
   working directory. `DHARMA_EXTERNAL_IDEMPOTENCY_KEY` and
   `DHARMA_ACTION_DIGEST` come only from a verified action-decision receipt and
   are absent without one, even when the relay environment has them.

Anything else in the relay environment is not passed. That includes provider
and cloud credentials, relay configuration, `npm_*` variables, agent and session
sockets (`SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), provider
profile directories, `SHELL`, `TERM` and, on Windows, `HOMEDRIVE`, `HOMEPATH`,
`USERNAME`, `USERDOMAIN`, `COMPUTERNAME` and `PSModulePath`. A signed task cannot
add environment values. The task envelope schema has no such field.

A registered command that needs another variable, such as `HTTPS_PROXY`,
`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `CI` or a credential its
verifier uses, must name it in its policy entry:

```yaml
tasks:
  allowedCommands:
    test:
      argv: [npm, test]
      timeoutSeconds: 1200
      environment:
        inherit: [HTTPS_PROXY, NODE_EXTRA_CA_CERTS]
```

The value is read from the relay environment when the command runs. Before
provider execution, the task runner checks the `environment` entry of every
signed acceptance command. The task fails if an entry has keys other than
`inherit`, lists more than 32 names, lists a name that is not
`[A-Za-z_][A-Za-z0-9_]{0,127}` or lists the same name twice (compared
case-insensitively). It also fails for any name starting with `DHARMA_` in any
letter case, which covers the runner-owned names.

`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `XDG_CONFIG_HOME` are not
harmless. They locate per-user tool configuration and credential files, and are
passed only because npm and Git need them.

The allowlist removes relay variables from the command's own environment, so
they do not reach its output or the task receipt by accident. It is not an
isolation boundary. The command still runs as the relay user without an
operating-system sandbox, so it can read the relay user's files and can read
the relay process environment through the operating system's process
inspection interfaces.

Relay-internal Git calls, including the write-scope checks after each command,
run with the same operating-system essentials and with `core.fsmonitor`
disabled. A Git configuration change made by the provider or a command
therefore does not start a monitor hook, and helper programs that Git starts do
not receive other relay variables.

The provider launch environment is unchanged. Skill smoke checks run only from
`dharma skills sync --smoke-command`, never from the relay itself. They use the
explicit command environment: operating-system essentials and the names the
command's policy entry lists under `environment.inherit`, built by
`registeredCommandEnvironment`. They get no runner-owned names.

- [Task execution boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/06-task-execution-and-a2a.md)
- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/task-runner)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
