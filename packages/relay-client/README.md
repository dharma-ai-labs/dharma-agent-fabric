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
and an allowlisted phase. The CLI emits this record to stderr; stdout and the
existing sanitized exception remain unchanged. Observer failures are ignored.
No caught exception, server response, credential, approval URL or device data
is included. A phase describes the last local boundary attempted, not the
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

- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/relay-client)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
