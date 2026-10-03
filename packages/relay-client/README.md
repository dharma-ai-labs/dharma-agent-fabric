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

- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/relay-client)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
