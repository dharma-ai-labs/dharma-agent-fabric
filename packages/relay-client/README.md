# `@dharma-ai-labs/agent-fabric-relay-client`

Outbound device enrollment and relay client for Agent Fabric. It uses device
signatures, nonce and sequence replay protection, durable cursors, idempotent
receipts, and organization-scoped browser approval. It does not expose an
inbound shell or arbitrary local-file API.

## Read-only signing-expiry recovery planning

`planDeviceSigningRecovery()` prepares local public context under a mandatory
owning-host scope. The host supplies already verified source consent and native
session selections, never model/challenge declarations. The function reads the
selected device configuration and its matching protected public enrollment
anchor with fresh reads and `readOnly: true`. It does not migrate an old anchor,
read a private key, generate an identity, contact the server, issue a proof or
change trust. A second configuration read rejects replacement during planning;
scope withdrawal and elapsed session/15-minute limits deny output.

The plan is explicitly `local_context_only_not_recovery_authorization`. It does
not authenticate the selections against current server membership, role,
revocation, source policy or a live native session. Its recorded budget is only
an input to a binding digest, not new spending authority. The old anchor does
not itself attest installation, membership or source selection; the server and
trusted native caller must independently verify those before approval/use.
This API is not yet wired to bootstrap or an executable recovery command.

Canonical bindings use the existing `canonicalize()` UTF-8 JSON representation:

- `sourceSelectionDigest`: SHA-256 of
  `dharma.agent-fabric.signing-recovery-source-selection/v1` + NUL + canonical
  JSON of the exact source-selection fields and the existing public
  `setupClaimReference`. Source consent references map to the original
  generation/receipt/revision/policy-hash records, not raw repository contents.
- `nativeSessionBindingDigest`: SHA-256 of
  `dharma.agent-fabric.signing-recovery-native-session/v1` + NUL + canonical
  JSON of `{session, hostBinding, installationId}`. The session selection binds
  the exact member/device/repository/workspace/endpoint/binding/provider, named
  session/owner/times/budget; the host selection binds connection/context/thread/
  turn. Private local paths, cookies, transcripts and credentials are excluded.
- `previousAnchorHash`, `protectedConfigDigest` and `previousKeysetHash`:
  SHA-256 of canonical JSON of the exact corresponding public snapshots.
  The configuration hash includes the merged on-disk connection preference but
  changes none. It is not protected-store attestation; only the anchor snapshot
  comes from the protected store.
- `previousRootFingerprint`: SHA-256 of the canonical decoded 32-byte Ed25519
  public root. Digests use the `sha256:` lowercase-hex prefix.

Historical validation verifies the pinned-root signature and signer window
immediately before the recorded old expiry; it does not make that trust valid
now. This planner supports the pinned-root historical case, not arbitrary
post-rotation lineage. Unsupported history fails closed. New signer provenance,
owner/intended-recipient approval, one-use replay admission and a dedicated
protected installation/restart journal remain separate unimplemented gates.

`claimSetupReference` is the native, noninteractive public-reference enrollment
transport used by agent-run bootstrap. A reference confers no bearer authority.
The client proves its protected Ed25519 device identity, binds an ephemeral
encryption key to the exact challenge, and waits for the intended recipient's
browser approval. The compatible server must enforce its live authenticator,
immutable scope, deadlines and atomic approved-key enrollment/recovery.

Decrypted enrollment credentials remain inside this method and are saved only
through the existing protected credential store. Its return value contains
public device configuration and scope names. It never returns a token,
ciphertext, private key or private terminal input. HTTPS redirects, changed
approval context, expired responses and unavailable protected storage fail
closed. Source tests do not establish live enrollment or startup readiness.

The optional local `onFailureDiagnostic` observer receives only a frozen
`dharma.setup-claim-failure/v1` record with the fixed `setup_claim_failed` code
and an allowlisted phase. It may add a typed `reason`, the server's error code
as `serverCode` when it is a known code, and a server `correlationId`; `approval_expired` means browser
approval was not given before the wait ended. The CLI emits this record to
stderr, followed by the fixed `setupClaimFailureMessage` line when a reason is
known; stdout and the existing sanitized exception remain unchanged. Observer
failures are ignored. No caught exception, server message, credential, approval
URL or device data is included. A phase describes the last local boundary attempted, not the
remote root cause, proof that a preceding phase succeeded atomically, or
authority to retry. In particular, a `credential_commit` failure may retain
protected partial writes for the existing same-key recovery path.

This diagnostic does not provide a trusted pre-enrollment host callback, relax
the coding sandbox, or make an unavailable OS-backed store usable. Qualify
those runtime boundaries independently before actual onboarding.

`AgentFabricClient.open({ ...paths, readOnly: true })` uses the already accepted
device key and enrollment anchor without repairing or migrating them. Its one
`openSession()` creates a separate authenticated server protocol session; its
sequence and pending read remain in memory. It neither reads nor rewrites the
durable relay outbox and cannot replay its pending work. Subsequent application
POSTs, session replacement and implicit retry after an ambiguous read are denied.
Signed GETs retain normal device/session/nonce/sequence validation. This is not
an anonymous or server-side permission bypass: opening the session creates the
ordinary authentication/audit record. Report that effect separately from source,
plan and credential mutations. Unavailable or inconsistent protected identity
fails closed instead of enrolling or generating a replacement key.

## How long one signed relay request holds device signing control

Every signed request is signed, written to the local outbox, sent and
acknowledged while the device signing control for its origin, organization,
device and OS user is held. While one caller holds it, no other caller that
takes signing control signs or sends a request. Every write of the local
protocol state (the outbox, the session and recovered task completions)
happens under the device signing control and starts from the latest file, so
clients on one device never overwrite each other's kept requests or
completions when every process on the device runs this version. A process of
an earlier version still writes the whole file from its own copy and does not
read the per-client outbox entries described below. The relay upgrade stops
the relay before it switches versions, but a command of the earlier version
that is still running can overwrite the file until it exits.

An earlier version reads only one kept request, at the top level of the file.
Every write of this version copies the oldest kept request there, exactly as
signed (a session open, poll or read is never copied); this version never sends
that copy on its own. After a rollback to an earlier version, the first
session open of that version sends the copied request again, with the same
message id, and then writes a file without the per-client entries. Every other
kept request is then discarded, and whether the server received it stays
unknown.

Each client keeps its own outbox entry in the protocol-state file: its
session, its next sequence and at most one kept request. A relay workspace
loop uses one entry per workspace, and every other client gets an entry of its
own. A client signs, sends and replays only the kept request in its own entry,
in its own session, so another client's kept request never delays, fails or
answers its calls. A workspace loop that restarts finds its entry and sends its
kept request again, with the same message id, when it opens its session.

When the owner process has exited, as with an ad hoc command that stopped
during an outage, another client sends the kept request of that entry: the
next session open on the device, or a long-lived client such as a workspace
loop after one of its own requests. That client sends it in a signing-control
section of its own, which starts only once the request has returned its
answer, sends one kept request at most, and does not start while any client of
the process holds a task lease. So does a kept request that
stood unchanged for 10 minutes, even when its process id still answers (it may
have been reused or belong to another account) or when it belongs to a
workspace loop that never ran again; a workspace loop that restarts sooner
replays its own request first. The outcome never answers the client that sent
it and is never raised to its caller. An accepted or refused request leaves
the file. When its owner can still read the entry (a workspace loop, or a
process that still runs), the answer stays in the owner's entry for 10
minutes, and the next write after that removes it. An owner that still runs
takes that outcome from the file instead of sending the request again: when
its caller retries the same call, it returns that answer or raises that
refusal without signing the call again. Only an answer whose body is a JSON
object is kept; after any other answer the owner signs its retry again. The
client records each such send in
the file before it starts, so a request without a definite answer, including
one whose sender stopped during the send, stays in the file and is sent again
after at least 10 minutes. A session open
sends at most 4 such requests in its signing-control section and stops at the
first without a definite answer; while more are due, each next request of that
client sends one more. A kept session open, poll or read matters only to its
owner: another client removes an orphaned one without sending it, so the task
or content a poll or read returns is never written to the file. A kept request
in a file written by an earlier version is moved to such an entry when the file
is first read, unless it is the copy of a kept request in an entry. Entries without a kept request are removed once
their owner process has exited, except that an entry whose request another
client answered stays for 10 minutes, so an owner that read the entry before
still finds the answer.

The file holds at most 256 kept requests. A client without a kept request
still opens its session in a full file; that session open is not kept in the
file. Before a request that would add a
kept request to a full file, the client sends due requests of other entries to
make room; when none is due yet, the request is refused with
`relay_protocol_state_outbox_full`.

A signed request that is kept in the outbox may be sent again: see the two
cases below.

- **Connect phase: at most 30 s** (`RELAY_CONNECT_TIMEOUT_MS`). A relay
  connection that does not open in time fails with the code
  `relay_connect_timeout`. This attempt sent nothing. The signed request stays
  in the outbox and is sent on the next attempt, exactly as after any other
  failure that keeps it. An earlier attempt may already have sent it.
- **After the request is sent: up to 90 s from the start**
  (`RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS`). The gateway normally answers within
  about 35 s. If no answer arrives, the call fails with `relay_response_timeout`
  and the outcome is unknown, so the exact signed request is kept and may be
  sent again later. This window is not shortened: a shorter wait would resend
  requests that already succeeded.

Another process that needs signing control on the same device waits up to 10 s
and then fails with `connection_anchor_busy`. That error is raised before the
lock is held and before anything is signed, so retrying the call is safe. The
repository relay loop retries its session open on this error and restarts the
loop after a failure at a later stage; ad hoc callers should retry the call.
Callers in the same process wait in line for up to 120 s instead.

- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/relay-client)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
