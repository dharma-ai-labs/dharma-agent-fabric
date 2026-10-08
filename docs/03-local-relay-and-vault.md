# Local Relay and Vault

## Relay responsibilities

The local relay is the durable edge of the system. It must remain useful when the Dharma server is unavailable and must remain safe when the server sends invalid or unauthorized instructions.

## Process model

The released CLI exposes:

```text
dharma <command>
dharma relay start
dharma relay stop
dharma status
```

Completed onboarding starts the registered user-level supervisor. It restarts the relay after an unexpected process exit with bounded backoff. Complete bootstrap registers a per-user Windows logon task, Linux systemd user service, or macOS LaunchAgent using the pinned repository launcher and canonical policy path without storing a grant or device credential in the startup entry. Linux Codex setup also records a selected nondefault `CODEX_HOME` path, not its contents, in the owned version-4 registration and unit. It does not import the shell environment, provider credentials, passwords or keyring unlock material. Another repository cannot silently retarget that profile. Supported runtime rollback restores the preceding profile disposition, including an older context-free unit. Unscoped Linux recovery uses an existing registered service rather than creating a competing detached supervisor. `dharma status` reports the relay, supervisor, startup registration, and last successful poll. Startup is intended to resume after the enrolled operating-system user signs in, not before login. `dharma relay stop` stops the current process; `dharma relay autostart disable` removes the future logon entry. Linux without a systemd user bus, WSL without user-session startup, and macOS without a graphical login domain must report unavailable startup rather than a complete receipt. Registration or a preserved profile path alone does not prove protected-store recovery or native session continuity; verify them after an owned restart.

The macOS backend uses `~/Library/LaunchAgents/io.dharma.agent-fabric.relay.plist` and the current non-root `gui/<uid>` domain. Exact file and loaded-service checks reject foreign registration; startup files contain no enrollment credentials. Stop unloads the owned service; start reloads it under the same identity. This backend has local mocked lifecycle coverage; native parser, user-sign-in recovery and signed skill activation require macOS qualification before claiming production completion.

Windows and WSL are separate device environments. A user may enroll both under the same Dharma identity, but each gets a distinct device ID, keypair, workspace registry, capability inventory, vault, and policy receipt.

## Device enrollment

1. The user runs `dharma login`.
2. The CLI uses OAuth device authorization in a browser.
3. The CLI generates an Ed25519 keypair locally.
4. The private key is sealed through Windows Credential Manager, macOS Keychain, or Linux Secret Service.
5. The server binds the public key to a device record and issues a short-lived bootstrap token.
6. The relay exchanges the bootstrap token for a renewable device session.
7. Every outbound message carries a device signature in addition to TLS.

Device identity is not user authority. Server authorization still checks organization membership, workspace registration, and action scope.

## Local directory

```text
~/.dharma/
├── config.yaml
├── device.json
├── policy-cache/
├── registry/
│   ├── workspaces.json
│   └── providers.json
├── vault/
│   ├── vault.sqlite
│   └── blobs/
├── spool/
│   ├── outbound/
│   └── receipts/
├── tasks/
│   ├── leases/
│   └── worktrees/
├── skills/
│   ├── bundles/
│   ├── active/
│   └── rollback/
├── logs/
└── run/
```

All paths are configurable through a single documented environment variable for testing and managed deployments. An empty or malformed override must fail closed rather than fall back to another user's data.

## Vault design

### Metadata store

SQLite tables:

- `sources`
- `sessions`
- `events`
- `blobs`
- `capsules`
- `disclosures`
- `tasks`
- `skill_installations`
- `upload_cursors`
- `retention_jobs`

### Blob storage

- Content ID: BLAKE3 or SHA-256 over canonical plaintext.
- Encryption: XChaCha20-Poly1305 or AES-256-GCM with random nonce.
- Per-device master key sealed in the OS keychain.
- Optional organization-provided local encryption wrapping key.
- Atomic write through temporary file and rename.
- No plaintext spill in logs or crash reports.

### Source references

A blob may retain source locators such as provider session ID, file path, line range, tool call ID, or Git object ID. Source locators must be stored separately from uploaded normalized references because local absolute paths can reveal user identity.

## Workspace registration

`dharma workspace add <path>` must:

1. Resolve canonical path and Git root.
2. Detect monorepo topology.
3. Bind the workspace to one Dharma organization.
4. Record allowed repositories and nested members.
5. Generate a local workspace ID and server registration.
6. Load organization policy.
7. Probe provider support for that exact workspace.
8. Refuse overlapping registration to different organizations unless an explicit separation policy exists.

## Provider capability advertisement

The relay advertises capability slices independently:

```json
{
  "provider": "codex",
  "version": "observed-version",
  "evidence": "available",
  "configuredAssets": "available",
  "taskExecution": "available",
  "sessionContinuation": "partial",
  "skillInstall": "available",
  "activation": "next_session",
  "skillRollback": "available",
  "usageEvidence": "partial"
}
```

Missing version or unsupported source layout produces `unavailable`, not fallback to another provider.

## Capture loop

1. Watch configured provider roots and workspace Git state.
2. Index new records without treating write time as event time when native timestamps exist.
3. Qualify each session against the exact workspace.
4. Copy or reference raw evidence in the vault.
5. Normalize into provider-independent events.
6. Run local filtering and reduction.
7. Create or amend a capsule revision.
8. Add it to the durable outbound spool.
9. Upload when connected.
10. Retain the local raw evidence according to policy.

## Offline behavior

- Capture continues.
- Tasks already leased may continue if their policy allows offline completion.
- New server tasks cannot begin without a valid signed lease.
- Skill bundles already downloaded may activate only if their release envelope and activation time are valid.
- Upload cursors resume after reconnect.
- Spool pressure follows policy: pause capture, reduce retention, or alert. Never silently delete undisclosed evidence.

## Local control commands

```text
dharma status
dharma providers list --json
dharma workspace add <path>
dharma workspace pause <id>
dharma workspace remove <id> --preserve-vault
dharma evidence preview --workspace <id> --session <id>
dharma workspace sync <workspace-id> --policy-revision <revision> --apply
dharma evidence sync --file <capsule.json> --workspace-id <id> --policy <path>
dharma evidence run-request --policy <policy.json> --workspace-id <id>
dharma evidence disclosures --workspace <id>
dharma tasks list
dharma tasks inspect <id>
dharma skills status
dharma skills rollback <bundle-id>
dharma device revoke
```

## Local user authority

A local user may always:

- pause capture;
- disable a workspace;
- inspect what is pending upload;
- narrow evidence policy;
- reject a high-risk task that requires local confirmation;
- revoke the device;
- preserve or delete local data according to organization and legal policy.

A local user may not silently broaden organization policy or grant the server new write, network, merge, or deployment authority.

`relay start` polls for one signed evidence request before task delivery. The explicit
`evidence run-request` command runs the same verifier once for operator proof. In both
cases, the client verifies the server signature and request identity, decrypts only the
selected local-vault objects, applies the installed organization redaction policy and
the lower of the local/server byte caps, then records an idempotent disclosure receipt.
