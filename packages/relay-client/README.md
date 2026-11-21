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
takes signing control signs or sends a request. Each hold that the client or
the admission line takes makes at most one network send. When a request sends
another kept request before its own (its client's own earlier call, or another
entry's request to make room in a full file), that hold ends after that send,
and the request is signed and sent in a fresh hold, after every caller that
waited meanwhile. The relay workspace loops' admission line hands its hold back
in the same way, and so does a caller that holds signing control itself around
one signed call (the CLI's workspace policy sync) when it takes it with
`withSigningControlPerSend`: that caller's work then runs again in a fresh hold
before its own request is signed. A hold that a caller takes itself without
`withSigningControlPerSend` keeps its work in that hold, and the client adds no
send of its own to it: it sends no other entry's request there to make room,
and a full file refuses the caller's request
(`relay_protocol_state_outbox_full`), as before; after it sends its own earlier
kept call there, the caller's request fails with `relay_retry_after_recovery`,
unsent, and a retry signs and sends it in a hold of its own. Such a hold makes
one send for each signed call its caller makes in it, so a caller that holds
signing control across several calls holds it across several sends. The CLI
takes no such hold around a protocol-state request: the named session
activation boundary takes only the workspace skill activation lock, and each
signed call in a named session's turn takes a hold of its own. Every write of the local
protocol state (the outbox, the session and recovered task completions)
happens under the device signing control and starts from the latest file, so
clients on one device never overwrite each other's kept requests or
completions when every process on the device runs this version. A process of
an earlier version still writes the whole file from its own copy and does not
read the per-client outbox entries described below. The relay upgrade stops
the relay before it switches versions, but a command of the earlier version
that is still running can overwrite the file until it exits.

Only the owner of a session — the process that opened it, or a restarted
process with the same owner key for its own kept request only — signs in it,
from the sequence it holds in memory: no client reads another's session or
sequence from the file, and a restarted process with the same owner key opens a
session of its own for every other request. Every
other client sends a kept request only exactly as signed: every signed header
(message id, session, sequence, idempotency key, time, nonce and signature) and
the body byte for byte. The server refuses a signature older than 5 minutes, so
another client never sends a kept request signed more than 4 minutes ago: it
stays in its entry, unsent and with its outcome unknown, for its owner. Only the
client with that entry's owner key (its process, or a restarted process with
the same owner key) sends its own kept request again with a new time and
signature, and only with the same message id, session, sequence, body and
idempotency key. An earlier version reads only one
kept request, at the top level of the file, and gives one signed more than 4
minutes ago a new time and signature. Every write of this version copies
there, exactly as signed, the oldest kept request that is already due (see
below) and that another client may send unchanged. Any other entry is due only
after it stood unchanged for 10 minutes, so in practice the copy is a request a
command signed within the last 4 minutes before it exited. A live client's
fresh request, a request signed more than 4 minutes ago, a session open, poll or
read, and an action acknowledgement are never copied. Each later write
of this version drops the copy once it is 4 minutes old. This version never
sends that copy on its own. After a rollback to an earlier version, the first
session open of that version sends the copied request again, with the same
message id, byte for byte when it runs within 4 minutes of that signature, and
then writes a file without the per-client entries. When no write of this
version came between and the rollback is later, that version signs the
request again in the exited command's session, where no process of this
version signs any more. A rollback
loses at most the rest: every other kept request, whose outcome then stays
unknown, and the completion receipts that wait in an entry (see below).

Each client keeps its own outbox entry in the protocol-state file: its
session, its next sequence and at most one kept request. A relay workspace
loop uses one entry per workspace, and every other client gets an entry of its
own. A client signs and replays the kept request in its own entry, in its own
session, so another client's kept request never delays, fails or answers its
calls. Another client sends that request only in the cases below: once its
owner process has exited, or once its entry has stood unchanged for 10
minutes, even while its owner still runs, and in both cases only while its
signature is recent enough to send byte for byte as signed (see above). A workspace loop that restarts finds its entry and sends its
kept request again, with the same message id, when it opens its session.

When the owner process has exited, as with an ad hoc command that stopped
during an outage, another client sends the kept request of that entry: the
next session open on the device, or a client opened with an owner key, such
as a workspace loop, after one of its own requests. A one-shot command sends
such a request only when it opens its session, so it exits once its last call
returns. That client sends it in a signing-control
section of its own, which starts only once the request has returned its
answer, sends one kept request at most, and does not start while any client of
the process holds a task lease. A kept request that stood unchanged for 10
minutes is due too, even when its process id still answers (it may have been
reused or belong to another account) or when it belongs to a workspace loop
that never ran again; but it was signed at least that long ago, so another
client leaves it in the entry for its owner, as below. The outcome never answers the client that sent
it and is never raised to its caller. An accepted or refused request leaves
the file. When its owner can still read the entry (a workspace loop, or a
process that still runs), the answer stays in the owner's entry for 10
minutes, and the next write after that removes it. An owner that still runs
takes that outcome from the file instead of sending the request again: when
its caller retries the same call, it returns that answer or raises that
refusal without signing the call again. Only an answer whose body is a JSON
object is kept. When no answer is there (any other answer, or one removed
after its 10 minutes), the owner sends the request it signed again, with the
same message id and idempotency key; it never signs that call again. Only an
action acknowledgement older than 8 minutes is signed again, with a new message
id and the same idempotency key, and only by its owner process in its own open
session, at its next sequence. A process that took it over with its owner key
signs it again only in the session it opens, once the server accepted that
session open. Until then it signs no other call, and the acknowledgement stays
in the owner's entry, so when that session open fails or the process stops,
the next process with the owner key takes it over again, and when the server
refuses it, the process's next session open signs it again. Another client
never sends such an acknowledgement, nor a kept request signed more than 4
minutes ago, nor a kept
session open, poll or read: it leaves them in the entry while their owner can
come back (a workspace loop that restarts, or a process that still runs), and
removes them unsent once that owner is gone (a command that exited, or an
entry moved from an earlier version's file). The
client records each such send in
the file before it starts, so a request without a definite answer, including
one whose sender stopped during the send, stays in the file and is due again
after at least 10 minutes. By then it was signed too long ago for another
client to send: it stays for its owner, or is removed unsent once that owner is
gone. A session open sends at most one such request in
its signing-control section, and none when it replays its own kept request
there, so another process that waits for signing control waits for at most
one such send; while more are due, each next request of a client opened with
an owner key sends one more. A kept session open, poll or read matters only to
its owner, so the task or content a poll or read returns is never written to
the file. A kept request in a file written by an earlier version is moved to
such an entry when the file is first read, unless it has the message id of a
kept request in an entry (it is then that entry's copy). Such an entry has
no owner process: it is due only once it has stood unchanged for 10 minutes,
counted from when it was last signed or stamped, so a command of the earlier
version that still runs sends its own request first. By then its signature is
too old to send as signed and no process of this version opened its session,
so this version removes it unsent, and its outcome stays unknown.
Another client's entry stays in the file only while it holds a kept request,
waiting completion receipts, or an answer another client got for it in the
last 10 minutes; every other entry is removed on the next write, so clients
that come and go never fill the file. When the kept request of an owner that
still runs leaves its entry (an earlier version rewrote the file or wrote back
an older copy, or the file was removed), the owner keeps the request and its
session: it writes the request back to its own entry before it sends it again,
exactly as signed, and signs its next call at the next sequence it holds in
memory.

The file holds at most 1,000 recovered task completions. A new completion is
refused while that list is full, but a kept completion is still sent again,
since the server may already have accepted it. A completion the server accepted
is never dropped: when the list has no room for it, its receipt waits in its
client's entry, which stays like an entry with a kept request, and the next
write by any client that finds room moves it to the list. Acknowledging a
completion removes its receipt from the list and from any entry it waits in.

The file holds at most 256 kept requests. A client without a kept request
still opens its session in a full file; that session open is not kept in the
file. Before a request that would add a
kept request to a full file, the client sends a due request of another entry to
make room, in a hold of its own; when none is due yet, or the file is still
full after that send, the request is refused with
`relay_protocol_state_outbox_full`. A new kept request that an earlier version
adds to a full file stays at the top level of the file, in place of the copy
described above, until a client of this version sends it or removes it unsent.

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
