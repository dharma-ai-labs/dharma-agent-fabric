# `@dharma-ai-labs/agent-fabric-local-vault`

Encrypted, content-addressed local storage for complete Agent Fabric trajectory
evidence. The vault seals its master key through the operating-system secure
store and fails closed when secure key storage is unavailable.

Trusted setup hosts can pass a `VaultKeyOperationScope` as the second argument
to `loadOrCreateVaultMasterKey`. The helper requalifies before and after each
store effect, withholds a key after cancellation, and disables the developer
environment-key fallback for that operation. It neither unlocks an OS store nor
proves that an OS adapter child has terminated. A completed write remains a
partial effect if subsequent admission is withdrawn.

- [Evidence boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric#cognitive-integrity-evidence-ladder)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/local-vault)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
