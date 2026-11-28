# Security, Privacy, and Threat Model

## Security posture

Dharma Agent Fabric has deep access to developer trajectories and can execute repository tasks. The system must be designed as a high-trust developer infrastructure product, not as a convenience plugin.

## Protected assets

- source code;
- prompts and agent conversations;
- Git history and diffs;
- command output;
- credentials and secrets;
- customer and employee identity;
- proprietary Skills and policies;
- hidden eval truth;
- remediation logic;
- device keys;
- organization billing and usage;
- release and rollback authority.

## Principal threats

### T1. Secret exfiltration

A trajectory contains an API key, `.env` value, connection string, private key, or token.

**Controls:** local secret filtering, path exclusion, value-level tests, no raw logs, expansion re-filtering, customer patterns, incident revocation.

### T2. Cross-workspace evidence contamination

A provider's global session store includes unrelated repositories.

**Controls:** exact workspace binding, positive and negative fixtures, canonical path handling, no unqualified global session ingestion.

### T3. Malicious or compromised server task

The server sends a broad command or attempts to read unrelated local data.

**Controls:** outbound-only connection, signed typed tasks, local default-deny policy, exact workspace, approved commands, worktrees, expiry, replay protection, local rejection.

### T4. Compromised relay device

An attacker steals device credentials or local vault access.

**Controls:** OS keychain, encrypted vault, revocable device key, short-lived sessions, device posture, no reusable organization admin token, remote revocation.

### T5. Supply-chain attack through skill update

A malicious or accidental Skill release reaches all agents.

**Controls:** branch and release separation, exact commits, deterministic bundle, signatures, risk classification, no self-approval, canaries, activation smoke, rollback.

### T6. Judge leakage

Hidden truth or held-out cases become visible to the agent under evaluation.

**Controls:** separate stores and identities, freeze output before judge context, no shared prompt cache, audit input hashes, leakage tests.

### T7. Cross-tenant data access

One organization accesses another's trajectories, tasks, Skills, or receipts.

**Controls:** organization-bound authorization, tenant-scoped database queries, object-store prefixes, per-organization keys, row-level security as defense in depth, negative tests.

### T8. Employee surveillance misuse

Managers use trajectory data for covert personnel monitoring unrelated to agent reliability.

**Controls:** clear employee disclosure, purpose limitation, role-based access, workspace boundaries, retention controls, derived team reporting by default, audit of content access, local visibility.

### T9. Unbounded model cost

A server loop repeatedly invokes judges or managed agents.

**Controls:** purpose-specific budgets, hard caps, idempotency, model allowlists, recursion limit, approval threshold, cost receipts.

### T10. Remote task escapes worktree

A task modifies the active developer workspace or external path.

**Controls:** canonical path containment, OS sandbox where possible, worktree root enforcement, write interception, command policy, post-task diff audit.

### T11. Provider-written code runs as the relay user

A registered command (an acceptance command or the external-effect receipt
command) runs code the provider may have written into the task worktree. Run
as the relay's operating-system user, it could read that user's credential
files, the Dharma home, other processes and the network.

**Boundary:** registered commands run only inside a bubblewrap sandbox on Linux
and WSL2. Each command gets new user, process, IPC, host-name, cgroup and
network namespaces; no capabilities; an empty read-only root with system
folders and the relay's Node binary and npm package (not the rest of its
installation folder); private `/proc`, `/dev`, `/tmp` and
home; and the task worktree as the only writable folder, with its `.git`
pointer read-only. A live probe checks this policy, not only the presence of
bubblewrap, before every task that names registered commands. Tasks that name
registered commands are refused before the provider starts when the host has no
usable sandbox (macOS, native Windows, WSL1, containers, hosts without
bubblewrap or user namespaces) or when the task's network authority is not
`deny`. There is no opt-out. A sandbox that fails to start fails the task; the
command is never re-run on the host. The provider gets no command tools for
these tasks, so the same commands cannot run unsandboxed during the provider's
turn. The relay's own Git calls for a task, including the write-scope checks
after the provider and after each command, run nothing the task could have
written. Only the calls before any task code runs (reading the operator's
checkout settings and global exclude file, and `git worktree add`) use the
operator's normal Git configuration, so the task worktree matches the
operator's checkout. Every later call runs from a relay-owned folder (so a
`git` program written into the worktree is never found); ignores system and
global Git configuration (`GIT_CONFIG_NOSYSTEM`, a relay-owned empty
`GIT_CONFIG_GLOBAL`, and a relay-owned empty `HOME` and `XDG_CONFIG_HOME`)
apart from the checkout settings and exclude file read before the task; uses a
relay-owned empty hooks folder and turns off the file-system monitor, the
untracked cache and the global attributes file; reads attributes from the
starting commit (`--attr-source`, Git 2.40 or later; an older Git fails the
task closed when a `.gitattributes` file changed or appeared); never looks
inside submodule folders; uses repository paths pinned before the provider
ran; turns off external diff and text-conversion drivers; and checks, before
and after each call, that the `.git` pointer and the Git-directory attributes
and exclude files are unchanged and that the repository configuration changed
in no entry other than `branch.*`, `remote.*`, `lfs.<url>.access`,
`submodule.<name>.url` and `submodule.<name>.active`. A `.gitignore` the task
changed or added must sit inside the write paths, in a `.pytest_cache`,
`.mypy_cache` or `.ruff_cache` folder, or in a folder that rules the task did
not write already ignore. Any other change fails the task closed with
`relay_git_isolation_failed`. Because Git never looks inside submodule
folders, the write-scope check also compares each submodule folder outside the
write paths with what it held right after the checkout.

**Residuals:**

- The provider process is a trusted component, not a sandboxed one. The Codex
  provider runs under its own sandbox setting; other providers' own tools are
  outside this boundary.
- Kernel flaws in namespaces or bubblewrap are out of scope.
- No seccomp filter yet. On bubblewrap below 0.8.0 (for example Ubuntu 22.04),
  nested user namespaces are not blocked.
- Filter and diff drivers that the operator's configuration defines (for
  example large file storage) still run for paths that the starting commit's
  attributes assign to them. That configuration is read before the task.
- The provider process can still change the Git or relay binaries themselves.
- Skill smoke checks are operator commands and are outside this boundary.
- Behaviour on real WSL2 hosts, including the Windows interop cut, is checked
  by the probe on each host but not yet by a recorded qualification.
- Tasks with registered commands and a network grant are refused; there is no
  command-level network deny for them yet.

## Data classification

| Class | Examples | Default handling |
| --- | --- | --- |
| Restricted | secrets, credentials, private keys | Never uploaded; redact locally |
| Confidential source | code, diffs, prompts, transcripts | Upload only under workspace policy; encrypt and retain narrowly |
| Sensitive identity | names, emails, home paths | Pseudonymize unless operationally required |
| Internal metadata | task IDs, provider versions, skill versions | Organization-scoped storage |
| Public | open-source Skill docs, public plugin metadata | Public repository permitted |

## Organization policy and employee disclosure

Before `reduced_full_session` or `incident_capture` is enabled, the organization must define:

- repositories in scope;
- participants and roles;
- evidence purpose;
- content categories;
- local and server retention;
- who can inspect raw excerpts;
- whether employee-level identity is visible;
- whether evidence may be used for performance management;
- model providers used for analysis;
- cross-customer reuse policy;
- deletion and subject-access process;
- incident process.

The CLI displays the active policy and current upload preview.

## Local user controls

The user can:

- view pending capsule contents;
- view redactions and omissions;
- pause one workspace;
- reject a task that requires local confirmation;
- inspect installed Skills;
- revoke the device;
- request local deletion when policy permits.

## Cryptography

### Device identity

- Ed25519 signing key.
- Public key registered with device.
- Rotation and revocation supported.

### Local vault

- XChaCha20-Poly1305 or AES-256-GCM.
- Master key sealed by OS keychain.
- Per-blob nonce.
- Authenticated metadata.

### Transport

- TLS 1.3.
- Application-level signed envelopes.
- Optional mTLS for enterprise deployments.

### Server storage

- Per-organization KMS envelope encryption.
- Separate object prefixes and access policies.
- Encrypted backups.
- Key rotation and deletion process.

### Skill releases

- Ed25519 or Sigstore-compatible signing.
- Exact bundle hash and source commits.
- Offline-verifiable public release key.

## Authorization model

Actors:

- local developer;
- organization member;
- organization agent operator;
- eval owner;
- skill author;
- skill release approver;
- security approver;
- device;
- local relay;
- managed worker;
- GitHub App;
- MCP app client.

Capabilities are named and narrow. Examples:

```text
agent_fabric.devices.read
agent_fabric.devices.manage
agent_fabric.trajectories.read
agent_fabric.evidence.request
agent_fabric.tasks.create
agent_fabric.tasks.cancel
agent_fabric.messages.send
agent_fabric.evals.create
agent_fabric.remediations.propose
agent_fabric.skills.edit
agent_fabric.skills.release
agent_fabric.skills.rollback
agent_fabric.billing.read
```

A human role does not automatically grant device or task authority.

## Audit

Tamper-evident audit events are required for:

- login and enrollment;
- device key rotation or revocation;
- workspace registration;
- evidence policy change;
- capsule upload;
- expanded evidence request and response;
- raw excerpt inspection;
- task creation, acceptance, cancellation, and completion;
- A2A message delivery;
- judge invocation;
- rubric proposal;
- remediation PR;
- skill release, install, activation, and rollback;
- cost-cap decision;
- data deletion.

## Retention

Configure separately:

- raw local evidence;
- reduced server content;
- structured metadata;
- eval datasets;
- remediation evidence;
- audit receipts;
- backups.

Deletion must propagate through primary stores, derived assets where traceable, and backup expiry. Immutable audit may retain non-content evidence of the deletion action.

## Security acceptance gates

Before pilot:

- secret-leakage fixture suite passes;
- cross-workspace negative tests pass;
- task path escape tests pass;
- replay and expiry tests pass;
- skill signature and rollback tests pass;
- tenant isolation tests pass;
- device revocation test passes;
- a documented employee and customer data policy exists;
- an incident response owner is named.

Before broad release:

- independent security review;
- threat-model refresh;
- dependency and artifact provenance;
- signed binaries;
- secure update channel;
- penetration test of relay and control plane;
- deletion verification;
- disaster recovery exercise.
