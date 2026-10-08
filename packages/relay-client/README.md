# `@dharma-ai-labs/agent-fabric-relay-client`

Outbound device enrollment and relay client for Agent Fabric. It uses device
signatures, nonce and sequence replay protection, durable cursors, idempotent
receipts, and organization-scoped browser approval. It does not expose an
inbound shell or arbitrary local-file API.

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
