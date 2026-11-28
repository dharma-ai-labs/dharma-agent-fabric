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

Operators can run the same probe without a relay or a task:
`dharma relay sandbox status [--json]` calls `detectRegisteredCommandSandbox()`
on the relay state directory once and prints the usable sandbox (bubblewrap
path, version, `sha256`, policy, host kind and passed checks; exit code `0`) or
the refusal `reason`, `detail` and `fix` (exit code `1`). It is read-only: it
takes no option but `--json`, admits no task, writes no receipt and removes any
folder it had to create for the probe. The JSON form is
`schemas/relay-sandbox-status.v1.schema.json`. `network_not_denied` belongs to
one task, not to the host, so the command never reports it.

### Provider command tools

When a task names registered commands, the provider gets no command tools
(`allowedCommandArgv` is empty). For Claude tasks this means no `Bash(...)`
tools: the commands run only in the sandboxed acceptance loop after the
provider stops. Every named command must still resolve in the policy the relay
loaded before the provider started; no command lookup reads the workspace policy
file again.

### Command policy snapshot

For command lookups, the relay reads `<workspace>/.dharma/approved-policy.json`
once per task, at admission, before the skill activation lock, `started` and the
provider. It then calls `snapshotRegisteredCommandPolicy(task, policy)`: a copy
of the policy entries for the commands the task names in `authority.commands`,
with the task ID, organization ID and policy revision, frozen at every level. It
passes the copy to `executeTask({ commandPolicy })`. The runner checks that the
copy belongs to this task (task ID, organization, revision) and is frozen, or it
fails before any worktree or process starts. Every command lookup, before and
after the provider, reads only this copy. A caller that passes no copy gets one
taken from `policy` before anything runs.

The provider runs unsandboxed as the relay user, so it can rewrite the policy
file or the workspace launchers (`.dharma/bin/dharma`, `.dharma/bin/dharma.cmd`)
while it runs. That changes nothing for the task it runs in: its commands come
from the copy taken at admission. A registered command cannot change them at
all: the sandbox does not show the workspace, only the task worktree.

What this does not cover: the registered commands in the policy file are local
operator configuration, not part of the server-signed workspace authorization,
and nothing pins them. The next task reads the file as it is then. A pin kept on
this host would not help, because the provider runs as the same user and could
rewrite the pin as well. Closing this needs the registered commands inside the
server-signed authorization.

### Other routes to a registered command

- `remediation_smoke` tasks are tasks like any other. They pass the same
  admission and their commands run in the same sandbox.
- Skill smoke checks start only from the operator's
  `dharma skills sync --smoke-command <id>`. No task field names one, the task
  path installs no skill, and the relay's automatic skill activation passes no
  smoke command. A smoke check runs in the installed bundle's folder, on the
  host, outside the sandbox.

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

### The sandbox in the task receipt

Every receipt `executeTask()` writes is revision 2 (`schema:
'dharma.task-receipt/v2'`, contract `schemas/task-receipt-v2.schema.json`) and
names the command sandbox in `commandSandbox`:

```json
{
  "state": "sandboxed",
  "host": "linux",
  "bwrapPath": "/usr/bin/bwrap",
  "bwrapVersion": "0.9.0",
  "bwrapSha256": "sha256:<64 hex>",
  "policy": "bwrap-policy/2",
  "probe": { "result": "passed", "checks": ["outside_canary_hidden", "..."], "probedAt": "<ISO time>" }
}
```

- `sandboxed`: the task names registered commands and was admitted with this
  probed sandbox. It is recorded even when the task ended before a command ran;
  `commandResults` say which commands ran. `checks` are the named probe checks
  this sandbox passed (`PROBE_CHECKS`), so they differ by bubblewrap version
  and host kind.
- `not_used` (`{ "state": "not_used" }`): the task names no registered command.
  A sandbox the relay passed for such a task is not recorded.
- `unavailable`: only in a receipt written after a receiver restart, when the
  interrupted execution's journal entry was written before receipts carried the
  tuple. Otherwise that receipt reports the tuple the journal recorded for the
  interrupted execution, not the sandbox probed after the restart.

The runner builds and checks the tuple right after admission, before any
worktree or process, and stores it in the action execution journal for
receipt-required tasks. `FileTaskReceiptStore` and the journal reject a
revision 2 receipt without a valid tuple, a revision 1 receipt that carries
one, and any other `schema` value. Revision 1 receipts (no `schema`, no
`commandSandbox`), written before this revision, are still returned on a
delivery retry. The relay posts `commandSandbox` with the task outcome and
prints it in its `--json` output.

### Relay Git after the provider and after a command

The relay's own Git calls for a task run nothing that the provider or a command
could have written.

Before any task code runs, the relay reads the operator's checkout settings
(`core.autocrlf`, `core.eol`, `core.longpaths`, `filter.lfs.*` and the global
exclude file, from `core.excludesFile` or the default
`$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore`) and creates the
worktree with `git worktree add`. These calls use the operator's normal Git
configuration, so the task worktree matches the operator's own checkout: Git
LFS files are smudged, line endings follow the operator's settings, and the
operator's `safe.directory` applies. They still use the relay-owned empty hooks
folder and no file-system monitor.

Every later call (the task branch and the write-scope checks after the provider
and after each command):

- Runs from a relay-owned folder (`<relay state>/relay-git/home`) and names the
  repository with `-C`, so a `git.exe` or `git.com` the task wrote into the
  worktree is never started (Windows looks for a program in the working folder
  before `PATH`).
- Ignores system and global configuration: `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL` names a relay-owned empty file, and `HOME` and
  `XDG_CONFIG_HOME` name a relay-owned empty folder. The operator's checkout
  settings read before the task are passed as `-c` options, so the checks
  compare files the way the checkout wrote them. `PATH` keeps only its
  absolute entries, here and in the calls before the task: Git starts filter
  programs (for example Git LFS) through the shell from the worktree root,
  where an empty or relative entry such as `:` or `.` would find a program the
  task wrote. The other operating-system essentials are unchanged.
- Turns hooks off: `core.hooksPath` names a relay-owned empty folder, never a
  path inside the worktree. `core.fsmonitor` and `core.untrackedCache` are off,
  `core.attributesFile` names the empty file, and `core.excludesFile` names the
  operator's global exclude file read before the task.
- Reads attributes from the starting commit: with Git 2.41 or later the relay
  passes `--attr-source=<starting commit>`, so a `.gitattributes` file the task
  wrote or changed cannot assign a filter, diff or merge driver. With an older
  Git, the relay records the starting `.gitattributes` files as checked out and
  fails the task closed (`relay_git_isolation_failed`, reason
  `attributes_changed`) before the next `diff` if any of them changed or a new
  one appeared.
- Uses the repository paths read from the worktree's `.git` pointer right after
  `git worktree add` (`--git-dir` and `--work-tree`). `diff` runs with
  `--no-ext-diff --no-textconv --ignore-submodules=dirty`, and every call sets
  `submodule.recurse=false` and `diff.ignoreSubmodules=dirty`, so Git never
  starts `git status` inside a submodule folder that the task turned into a
  repository with its own filters. A changed submodule commit is still
  reported when Git can resolve it.
- Checks submodule folders in the write-scope check: `git diff` and
  `git ls-files --others` never look inside a submodule folder, so the relay
  records what each submodule folder of the starting commit held right after
  `git worktree add` (normally nothing; files read with `lstat`, links not
  followed) and fails the task if a submodule folder outside the write paths
  differs after the provider or a command. A task that has to populate a
  submodule (`git submodule update --init`) needs that folder in its write
  paths.
- Checks, before and after the call, that the `.git` pointer bytes, `commondir`,
  the Git-directory `info/attributes` and `info/exclude` files, and the
  relay-owned empty file and hooks folder are unchanged, and that the
  repository configuration (`config`, `config.worktree`) changed in no entry
  other than `branch.*`, `remote.*`, `lfs.<url>.access`,
  `submodule.<name>.url` and `submodule.<name>.active` (what `git push -u`,
  `git checkout -b`, `git remote add`, Git LFS and `git submodule init` write;
  relay Git never fetches, pushes or updates submodules). A change fails the
  task closed with `RelayGitIsolationError`
  (`relay_git_isolation_failed`, reason `pointer_changed` or
  `git_files_changed`).
- Checks `.gitignore` files in the write-scope check: a `.gitignore` the task
  changed or added (including one that ignores itself) is accepted only when
  its folder is inside the write paths, when its folder is a `.pytest_cache`,
  `.mypy_cache` or `.ruff_cache` folder (these tools write a self-ignoring
  `.gitignore` into the cache folder they create, and its rules reach only
  that folder), or when rules the task did not write already ignore its
  folder. Folder names reach `git check-ignore` with a `./` prefix, so a name
  such as `:dist` is not read as pathspec magic. Otherwise the task fails
  closed (reason `ignore_rules_changed`; the message names the folder). A task
  therefore cannot change the root `.gitignore` unless it may write every
  path. Repositories should list the folders that their other tools create in
  their ignore rules, so that a provider or command that runs those tools
  does not fail the task.
- Checks what Git does not list: `git ls-files --others` skips every entry
  named `.git`, anything inside a folder it cannot open (with only a warning
  and exit code 0) and named pipes and sockets. Any standard error output from
  a write-scope `ls-files` call fails the task. The relay also walks the
  worktree itself (`lstat` semantics, links not followed), skipping the write
  paths, submodule folders, the root `.git` pointer and folders that the
  ignore rules ignore (confirmed with `git check-ignore`; tool cache folders
  are still walked), and fails the task on a `.git` entry, a folder it cannot
  read, or a file that is neither a regular file nor a link.

What this does not cover:

- Filter and diff drivers that the operator's configuration defines (for
  example Git LFS) still run for paths that the starting commit's attributes
  assign to them. That is operator content, read before the task, not task
  content.
- Global and system settings other than the checkout settings above and the
  global exclude file do not apply to the relay's checks after the task.
- The provider process runs as the relay user and is not sandboxed; it can
  change the Git or relay binaries themselves, which these checks do not cover.
- Files hidden inside a `.pytest_cache`, `.mypy_cache` or `.ruff_cache` folder
  outside the write paths are accepted.

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
  command, outside this sandbox. No task starts one (see "Other routes to a
  registered command").
- The registered commands in the approved policy file are not server-signed or
  pinned; a later task reads the file as it is then (see "Command policy
  snapshot").
- After a completed task with a skill bundle, the relay reads the workspace
  policy file again, after the provider ran, for the content-transmission check
  before it uploads the task's trajectory. That read decides only whether
  evidence is uploaded; it never supplies a command or its argv.

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

Relay-internal Git calls, including the write-scope checks after the provider
and after each command, run with the same operating-system essentials, except
that, after the worktree is created, `HOME` and `XDG_CONFIG_HOME` name a
relay-owned empty folder and system and global Git configuration are turned off
(see "Relay Git after the provider and after a command"). Helper programs that
Git starts do not receive other relay variables.

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
