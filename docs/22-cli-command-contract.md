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
dharma diagnostics <subcommand>
```

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
dharma workspace sync --workspace <id> --api-url <url> --apply
dharma evidence sync --workspace <id> --provider <id> --policy <path> --json
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
dharma skills status --provider <codex|claude|agy>
dharma skills verify --provider <codex|claude|agy> --workspace <path>
dharma skills sync --workspace-id <id> --provider <codex|claude|agy> --policy <path>
```

`skills verify` checks both the repository-scoped Skill and the provider-native managed bootstrap. `skills sync` polls for an approved, signed rollout and installs it with a receipt. Bundle inspection, planning, promotion, and rollback remain dashboard/control-plane operations; they are not public CLI commands in this release.

## Policy

```text
dharma policy show --workspace <id> --json
dharma policy explain --workspace <id> --action <action> --json
dharma policy local-narrow --workspace <id> --file <policy.yaml> --json
```

No command broadens organization policy locally.

## Relay

```text
dharma relay install --json
dharma relay start --json
dharma relay stop --json
dharma relay status --json
dharma relay logs --since 1h
dharma relay uninstall --preserve-vault --json
```

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
