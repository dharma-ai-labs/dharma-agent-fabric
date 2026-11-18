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

## Registered commands run inside an operating-system sandbox

Registered commands are the acceptance commands a task names, including the
external-effect receipt command. They run code the provider may have written,
so they run only inside a bubblewrap sandbox on Linux and WSL2. Every other
host refuses tasks that name them, before the provider starts. There is no
opt-out: no flag, environment variable, configuration key or policy field turns
the sandbox off.

### Admission

The local relay decides, right after it polls a task and before it syncs
policy, takes the skill activation lock or posts `started`:

1. A task with an empty `authority.commands` and `acceptance.commands` runs as
   before. It is never probed.
2. A task that names registered commands must have network authority `deny`.
   Otherwise it is refused with reason `network_not_denied`.
3. The relay runs a live sandbox probe (below) for this task. If the probe is
   not usable, the task is refused with the probe's reason.

A refusal posts one terminal `failed` task event with
`{ phase: 'preflight', code: 'registered_commands_refused', reason }` and the
relay keeps polling. An admitted task passes the probed sandbox to
`executeTask({ registeredCommandSandbox })`. `executeTask()` applies the same
admission again, after signature, expiry and organization checks and before any
worktree, provider process or command starts. Without a usable sandbox it throws
`RegisteredCommandsRefusedError` (`code` `registered_commands_refused`, plus
`reason`). No task receipt is written, so nothing claims the task ran. A task
that was already completed and has a stored receipt still returns that receipt.

| Reason | Fix |
|---|---|
| `platform_unsupported` | Run the relay on Linux or WSL2. macOS and native Windows refuse. |
| `bubblewrap_missing` | Install bubblewrap from the distribution, then restart the relay. |
| `bubblewrap_too_old` | Install bubblewrap 0.6.0 or newer. |
| `bubblewrap_untrusted` | Reinstall bubblewrap so `/usr/bin/bwrap` is a root-owned, non-setuid file that only root can change. |
| `user_namespaces_unavailable` | Allow unprivileged user namespaces for bubblewrap (an administrator setting), use WSL2 rather than WSL1, and run the relay on the host rather than in a container. |
| `sandbox_probe_failed` | The sandbox started but a policy check failed. Run the relay on a supported host and report the named check. |
| `network_not_denied` | Give tasks that name registered commands the network authority `deny`. |

The relay also writes one `registered_command_sandbox` line to its log at start,
with the probe result or the reason and fix line.

### Provider command tools

When a task names registered commands, the provider gets no command tools
(`allowedCommandArgv` is empty). For Claude tasks this means no `Bash(...)`
tools: the commands run only in the sandboxed acceptance loop after the
provider stops. Every named command must still resolve in the policy the relay
loaded before the provider started; the workspace policy file is not read again.

### The sandbox

Each command starts as `/usr/bin/bwrap` (or `/bin/bwrap`, never a `PATH`
lookup) with:

- new user, process, IPC, host-name, cgroup and network namespaces, with no
  `-try` fallback: a host that cannot create one refuses;
- `--disable-userns` on bubblewrap 0.8.0 or newer, `--die-with-parent`,
  `--new-session`, `--cap-drop ALL`;
- an empty root with read-only `/usr`, the `/bin`-style folders, a few `/etc`
  files (dynamic linker, time zone, name-service, `passwd`, `group`, `hosts`)
  and, when it is outside `/usr`, only the relay's Node binary, its
  `lib/node_modules/npm` package and the `bin/npm` and `bin/npx` links into
  that package. The rest of that installation folder is not visible: it can be
  a general per-user folder such as `~/.local` that holds other tools' data,
  and its `etc` folder can hold a global npm configuration with tokens;
- private `/proc`, `/dev` and `/tmp`, and an empty home at `/dharma-sandbox/home`;
- the task worktree as the only writable folder, with its `.git` pointer file
  read-only; the root is remounted read-only after all mounts.

Nothing else from the host is visible: not the relay user's home, the Dharma
home, `/opt`, the rest of `/etc`, `/run`, `/var`, `/mnt` or other processes.
Toolchains installed under `/opt` or the home, and distribution packages that
keep part of their files under `/etc` (for example OpenJDK), do not work inside
the sandbox; such a command fails with a non-zero exit code, not a refusal. The command environment is the
explicit acceptance-command environment below, with `HOME`, `TMPDIR`,
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` pointing at the sandbox's own folders and
the relay Node's `bin` folder first on `PATH`. It is passed as the process
environment, never as arguments.

Bubblewrap reports the command's start on a status descriptor. If it never
reports the child, the task fails with a `runner` row
(`registered_command_sandbox_failed`) and the command is not run again on the
host. bubblewrap reports the child as soon as it is created, so a sandbox that
fails during its own setup after that point shows as a failed command whose
error output starts with `bwrap:`; the command did not run. The probe treats
that case as `user_namespaces_unavailable`. The command's own exit code is
recorded; a command killed by a signal
shows `128 + signal number`. A timeout or cancellation kills the bubblewrap
process group, and the private process namespace takes every descendant with
it, including detached ones. Cancellation is immediate.

### The live probe

The probe runs for every task that names registered commands; a usable answer is
never cached. On macOS and native Windows it returns `platform_unsupported`
without touching a file or starting a process. On Linux it checks that
bubblewrap is a root-owned regular file that is not writable by group or others
and not setuid, at least 0.6.0, and records its `sha256`. It then runs a check
program through the same argument builder and launcher as real commands, in a
fresh probe worktree with a synthetic canary beside it and a host loopback
listener. The program must report that the canary, the relay user's home and the
relay process and environment are hidden; network fails and only loopback
exists; writes outside the worktree fail and writes inside succeed; the `.git`
pointer is read-only; no inherited socket or file descriptors are open; no
capabilities remain; no agent sockets are visible; nested user namespaces fail
(bubblewrap 0.8.0 or newer); and on WSL2, that Windows interop and drives are
cut. A failed check refuses with `sandbox_probe_failed` and names only the
check, never values.

### Relay Git after a command

The relay's own Git checks after each sandboxed command use the repository
paths read from the worktree's `.git` pointer when the worktree was created,
before the provider ran (`--git-dir` and `--work-tree`). They check that the
pointer bytes are unchanged (a change fails the task) and run `diff` with
`--no-ext-diff --no-textconv`. Other relay Git calls are unchanged.

### Limits

- Commands have no network. Tasks that need network for their commands are
  refused.
- Git is not available inside the sandbox: the repository's object store is
  outside the worktree.
- Toolchains installed under the relay user's home, other than the relay's own
  Node, are not visible. Dependencies must already be in the worktree; nothing
  installs them.
- The provider process itself is trusted, not sandboxed.
- No seccomp filter yet. On bubblewrap below 0.8.0, nested user namespaces are
  not blocked.
- Skill smoke checks (`dharma skills sync --smoke-command`) are an operator
  command, outside this sandbox.

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
they do not reach its output or the task receipt by accident. The allowlist is
not the isolation boundary; the operating-system sandbox above is. Inside it,
`HOME`, `TMPDIR`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` point at the sandbox's
own empty folders, and the relay user's files and processes are not visible.

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
