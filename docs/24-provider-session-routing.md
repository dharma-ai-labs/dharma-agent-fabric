# Provider-session routing qualification

Status: investigation. This is not a production capability claim.

## Observed boundary

At CLI `0.2.102` source commit `bc5682b`, the relay targets a device and endpoint, then the task runner creates an isolated Git worktree. The Codex adapter starts `codex exec`; the Claude adapter starts `claude --print --no-session-persistence`. Both advertise `sessionContinuation: unavailable`. Provider session discovery reads historical transcripts. None of these paths binds a task to a particular running chat. A signed delivery or a new provider process must not be described as a response from the user's selected chat.

Codex's documented app-server protocol has `thread/start`, `thread/resume`, and `turn/start` for a recorded thread. The local CLI also exposes `codex exec resume`. These are candidate transports for a **bridge-owned** conversation, not evidence that an unrelated Codex desktop chat is remotely writable. A no-model disposable-thread probe on Windows Codex 0.157 and WSL Codex 0.147 found that `thread/start` returns an ID but `thread/resume` reports `no rollout found` before the first turn. A persisted-turn test is therefore still required; the probe establishes no live answer capability. In particular, this active desktop task may have an owner, permission context, and pending turn that a separately spawned app-server cannot assume. A customer-controlled ChatGPT or Claude web conversation is unsupported until its provider supplies an authorized session API or an explicit in-session integration.

A separate Windows Codex 0.157 app-server process also performed `thread/read` with `includeTurns: false` for this task's explicit desktop thread ID. It returned the matching ID with status `notLoaded` and started no model turn. This establishes that the stored thread is visible to that process; it does **not** attest desktop ownership, current turn state, or permission to call `thread/resume` or `turn/start` against it. The read-only probe did not expose thread content to Agent Fabric.

Generated app-server TypeScript bindings from the installed Windows Codex 0.157 and WSL Codex 0.147 both define legacy `SandboxPolicy.readOnly` with `networkAccess` but without restricted readable roots. A Windows 0.157 wire probe rejected `readOnly.access` with an instruction to use permission profiles. A process-local `dharma_bridge` profile using minimal runtime reads, read-only workspace roots, and disabled network appeared as allowed in `permissionProfile/list`; `config/read` returned those exact effective settings. A `turn/start` carrying `permissions: "dharma_bridge"` reached the expected `thread not found` error for a random nonexistent thread, without a model turn. This establishes syntax and configuration visibility, not enforcement under a real turn. The prototype adapter checks the profile, workspace, and exclusive lease before dispatch. No CLI or relay path currently enables it. A disposable `thread/start` reported source `vscode` on both binaries; `canAcceptDirectInput` was `null` on WSL and `true` on Windows, and the originator did not match the probe's client name. These metadata fields cannot, by themselves, attest bridge ownership.

The bounded stdio transport was exercised against installed Codex binaries on WSL and Windows. In each case, `initialize`, `permissionProfile/list`, `thread/start`, and `thread/read` succeeded for a disposable `CODEX_HOME`; the read returned the same thread ID and workspace. No turn was started, no user conversation was resumed, and no provider cost was incurred. Fake-process tests cover fragmented frames, provider errors, unexpected provider-originated requests, oversized frames, and request timeouts. The transport remains internal and is not attached to a device vault, CLI command, or production relay.

An additive local-vault record now encrypts an explicit bridge-owned session ID and its organization, repository, workspace, endpoint, member, and device scope. The SQLite projection stores only a pseudonymous locator hash and binding ID. A transactional local lease denies another holder while the recorded process is alive; a revoked or expired binding fails the holder's check. If a process dies, another holder can reclaim the lease only when the operating system reports its PID absent. PID reuse or a vault shared across hosts can conservatively block recovery. This is a local ownership primitive, not a server-issued binding, an app-owned desktop-chat attestation, or an active relay integration. At `f4277ea`, all 20 local-vault tests passed in a native Windows clone after `npm ci --ignore-scripts` and `npm run build`; the WSL run passed too. A direct Windows run from the WSL checkout failed dependency resolution and is not the basis for the Windows claim.

An internal CLI dispatch now joins encrypted binding lookup, exact enrolled identity, local lease acquisition, signed-question verification, and one dedicated app-server transport. It opens the provider only after scope and lease checks, closes the provider before releasing ownership on a completed turn, and retains the lease if process termination cannot be confirmed. A model answer from a real bridge-owned thread has not been observed. The dispatch has no CLI command, server registration route, relay consumer, or customer-facing availability claim.

## First-thread wire qualification

The no-model bootstrap probe exposed additional prototype defects: permission-profile
fields require explicit `capabilities.experimentalApi` opt-in during `initialize`;
profile configuration also requires `default_permissions`. An idle newly created
thread has no persisted rollout and must not be resumed before its first turn.
The adapter now resumes only an unloaded, explicitly bound thread and rejects
anything other than idle after resume. The transport opts into experimental APIs
only when its caller explicitly requests `experimentalApi: true`; existing stable
transport calls remain unchanged.

Actual `config/read` responses include a nullable profile description and nullable
disabled network settings. The validator permits only the enumerated null defaults,
while rejecting enabled proxy/socket settings and unknown permission fields. This
is configuration validation, not proof of sandbox enforcement during model execution.

After build, run the guarded local probe:

```sh
node scripts/probe-codex-session-bootstrap.mjs /absolute/path/to/codex
```

It creates an empty synthetic workspace and disposable `CODEX_HOME`, creates and
reads only its own thread, validates the profile, and denies the budget reservation.
It never supplies a real user thread ID, customer content, enrollment grant, or
provider credentials. An additional guard refuses any `turn/start` request. Success
means the exact newly created thread reaches `codex_session_budget_unavailable`
with no question consumption or model turn. It is **not** a successful answer or
an enrolled Agent Fabric endpoint. Temporary probe directories are retained for
diagnosis; `--diagnose-launch` reports only the disposable process's startup error.

On Linux, `--check-sandbox` runs standalone `command/exec` requests using the same
named profile: an allowed synthetic file is readable, a synthetic file outside the
workspace is not, a workspace write is refused, and a working localhost service
cannot be reached. The parent process verifies the service first and `curl --version`
is a positive executable control. WSL Codex 0.147.0 passed all four checks. This is
actual standalone-command enforcement, not proof of a completed model turn.

Native Windows Codex 0.157.0 passes the focused unit tests but the real restricted
thread creation fails. The disposable home's unelevated restricted-token sandbox
reports that it cannot enforce split filesystem read restrictions. A no-model probe
using the existing configured home first passed `windowsSandbox/readiness`, but
thread creation still failed because the elevated helper requires effective root
read access. The probe did not add that authority, change saved configuration,
copy sandbox credentials, start setup, or fall back to unrestricted execution.
Windows named-session restricted execution remains unavailable in this tested
configuration; generic sandbox readiness alone cannot establish it.

`--configured-home /absolute/provider/home` is an explicit diagnostic option for
an existing local provider installation, not isolated-credential-store proof. It
uses only a newly created synthetic thread and does not resume any existing user
chat. `--diagnose-wire` reports a bounded startup error from that synthetic attempt;
do not upload private diagnostic paths without redaction. Existing desktop-chat
integration still requires an app-owned attachment or a supported in-session
receive/reply path. Do not weaken repository scope to satisfy a platform limitation.

Observed WSL Codex 0.147.0 created and read the same idle thread and reached the
budget guard after the fixes. Separate unit regressions first failed for experimental
opt-in, empty-thread resume, serialized profile defaults, and unknown post-resume
status; all pass after correction. Live answers, restricted-profile model turns,
recipient-approved server registration, and existing desktop-chat attachment are
still unverified.

## Required binding

Separate the logical repository agent, provider endpoint, and provider session. The device owner must explicitly attach a provider session to one endpoint and one normalized repository/workspace. Persist only the provider's opaque session ID and a local binding ID in the device vault; server-visible identity is a pseudonymous binding ID. Never discover the newest transcript and infer that it is the intended receiver.

A binding records organization, member, device, endpoint, repository, workspace, provider, provider version, capabilities, allowed question categories, creation and expiry, and the owning local process. A short lease with heartbeat describes **availability of the bridge**, not whether a model is executing. Only the local bridge may convert a signed, policy-authorized question into a provider turn. The sender cannot supply arbitrary provider session IDs or widen the receiver's authority. A session already controlled by another process must fail closed instead of being resumed concurrently.

The receiver moves each question through `accepted`, `executing`, `answered`, `failed`, `expired`, or `unavailable`. A delivery acknowledgment is not an answer. Preserve task ID, source and target endpoint IDs, binding ID, question ID, expiry, and answer receipt across retries. De-duplicate before provider invocation. On reconnect, replay only unfinished questions whose lease and authority remain valid. Disclose provider cost before execution and enforce the applicable local and organization budget.

## Safe implementation order

1. Probe Codex app-server using a disposable `CODEX_HOME`: initialize, create a thread, resume the exact ID, and read it. Do not start a model turn or touch an existing user thread in this probe.
2. Implement a provider-owned session bridge with an explicit local attach command and a durable binding record. Add negative tests for wrong organization, repository, member, device, workspace, expired lease, duplicate question, unavailable owner, and revoked authority. Keep the current fresh-process task runner unchanged.
3. In an isolated test account, run a bounded read-only question to a bridge-owned Codex thread and verify that `turn/start` returns an answer linked to that same thread. Prove a second question continues the same context and a different thread never receives it. Record actual provider cost.
4. Qualify Claude through its documented native session API or CLI resume contract separately. If safe same-session continuation is unavailable, report `not_supported`; do not silently substitute `claude --print`.
5. Test a desktop chat only through an approved app-owned integration that can attest thread ownership and turn state. Never use a rollout file path, shared local socket, or inferred recent-session ID as authorization.

Production acceptance requires a real two-machine, two-member named-session exchange; offline and active-turn behavior; signed package access in the target repository; provider restart; revocation; and no answer attributed to the wrong chat. Generic one-prompt enrollment remains a separate gate.

## Sources

- Current CLI source: `packages/provider-adapters/src/index.ts`, `packages/task-runner/src/index.ts`, `packages/contracts/src/task-envelope.schema.json` at `bc5682b`.
- Codex app-server protocol: https://developers.openai.com/codex/app-server
- Codex CLI: `codex exec resume --help` and `codex app-server --help`, inspected September 25, 2026.
