# CLI Command Contract

## Human and machine modes

Every command supports readable output by default and `--json` when used by agents or automation. JSON stdout contains no spinner, color, progress, or diagnostic prose.

## Root commands

```text
dharma login
dharma logout
dharma status
dharma device <subcommand>
dharma workspace <subcommand>
dharma providers <subcommand>
dharma evidence <subcommand>
dharma tasks <subcommand>
dharma messages <subcommand>
dharma skills <subcommand>
dharma policy <subcommand>
dharma relay <subcommand>
dharma sessions <subcommand>
dharma diagnostics <subcommand>
```

## Named Session Maintenance

Source-candidate commands require a capable client and running service; they are
not present in published CLI206:

```text
dharma sessions quiesce --name <name> --workspace-id <id> --fence-id <uuid> --apply
dharma sessions resume --name <name> --workspace-id <id> --fence-id <uuid> --apply
dharma sessions resume --name <name> --workspace-id <id> --fence-id <uuid> --recover-stopped --apply
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
protected provider binding. It only permits a subsequent explicit start; its
receipt is not runtime readiness, and interrupted work remains retained.
An unsupported service is rejected before a control request. Legacy `stop`
can interrupt work and is not proof of a drained boundary. These commands neither
change enrollment nor authorize an upgrade or additional provider work.

## Device

```text
dharma device status --json
dharma device rotate-key --json
dharma device revoke --yes --json
```

## Workspace

```text
dharma workspace add <path> --organization <id> --json
dharma workspace list --json
dharma workspace inspect <id> --json
dharma workspace pause <id> --json
dharma workspace resume <id> --json
dharma workspace remove <id> --preserve-vault --json
```

## Providers

```text
dharma providers list --workspace <path-or-id> --json
dharma providers probe <provider> --workspace <path-or-id> --json
dharma providers smoke <provider> --workspace <path-or-id> --no-write --json
```

## Evidence

```text
dharma evidence sources --workspace <id> --provider <id> --json
dharma evidence preview --workspace <id> --latest --json
dharma evidence capture --workspace <id> --provider <id> --json
dharma workspace sync <id> --policy-revision <revision> --apply
dharma evidence sync --file <capsule.json> --workspace-id <id> --policy <path> --json
dharma evidence run-request --policy <policy.json> --workspace-id <id> --json
dharma evidence disclosures --workspace <id> --json
dharma evidence export-local <trajectory-id> --output <path> --json
```

## Tasks

```text
dharma tasks list --json
dharma tasks inspect <task-id> --json
dharma tasks accept <task-id> --json
dharma tasks reject <task-id> --reason <code> --json
dharma tasks send <task-id> --message <text> --json
dharma tasks cancel <task-id> --reason <text> --json
```

Server-offered tasks can auto-accept only when every authority requirement is pre-approved by local policy.

## Messages

```text
dharma messages list --conversation <id> --json
dharma messages send --conversation <id> --target <selector> --state <state.json> --content <text> --json
```

## Skills

```text
dharma skills status --workspace-id <id> --provider <codex|claude|agy|hermes>
dharma skills verify --provider <codex|claude|agy|hermes> --workspace <path>
dharma skills sync --workspace-id <id> --provider <codex|claude|agy|hermes> --policy <path>
```

`skills verify` checks both the repository-scoped Skill and the provider-native managed bootstrap. Its `ready` field means that the generic bootstrap is installed and discoverable; it does not attest an active signed remediation bundle. Agy and Hermes use provider-native activation checks before the device signs an active receipt: Agy returns the signed bundle token through its plugin interface, while Hermes must trust the repository and report every signed Skill identifier through `hermes skills list --source local --enabled-only`. `skills sync` polls for an approved, signed rollout and installs it with a receipt only for providers whose lifecycle capability supports that operation. Active bundle state is workspace-scoped, so one provider installation can retain independently reversible releases for several connected repositories. Bundle inspection, planning, promotion, and rollback remain dashboard/control-plane operations; they are not public CLI commands in this release.

## Policy

```text
dharma policy show --workspace <id> --json
dharma policy explain --workspace <id> --action <action> --json
dharma policy local-narrow --workspace <id> --file <policy.yaml> --json
```

No command broadens organization policy locally.

## Relay

```text
dharma relay start --policy .dharma/approved-policy.json
dharma relay stop
dharma relay probe
dharma relay autostart status
dharma relay autostart disable
dharma status
```

Complete bootstrap starts the registered supervisor and configures per-user startup on Windows, Linux with a systemd user session, or macOS with the recipient's graphical login session. Linux Codex bootstrap preserves the selected nondefault `CODEX_HOME` location in its owned startup receipt, without copying credentials or importing arbitrary environment variables. Linux relay recovery uses that registered service instead of starting a competing detached supervisor. `relay start` is a foreground receiver; `relay stop` gracefully stops the current supervisor and receiver without deleting enrolled identity or vault data. The startup entry remains for the next user sign-in until `relay autostart disable` removes it. `status` reports startup registration and the last successful relay poll; `relay probe` independently checks the signed connection. Unavailable user-session startup is an incomplete bootstrap stage. Registration is not native reboot, protected-store recovery or signed skill activation proof; macOS qualification remains required.

## Exit codes

- `0`: completed successfully.
- `1`: command or operation failed.
- `2`: invalid arguments or schema.
- `3`: authentication or authorization denied.
- `4`: provider or evidence unavailable.
- `5`: policy denied.
- `6`: network unavailable with operation safely queued.
- `7`: partial result requiring inspection.
- `8`: signature, integrity, or replay failure.

Machine error output uses a stable JSON envelope.
