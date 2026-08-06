# Data, Privacy, and Security Summary

Dharma Agent Fabric receives bounded, policy-filtered trajectory capsules from
an outbound-only local relay. Full local evidence remains in the encrypted local
vault unless an authorized user explicitly confirms a bounded evidence request.

The remote MCP server:

- authenticates through Clerk OAuth;
- verifies active organization membership on every invocation;
- applies the same capability, rate-limit, audit, billing, and tenant boundaries
  as the underlying Dharma HQ APIs;
- requires idempotency keys for mutations;
- requires explicit confirmation for evidence expansion and every mutation;
- does not expose arbitrary shell execution, local file reads, generic merge or
  deployment, secrets, or direct provider credentials.

Retention and deletion follow the published Dharma privacy policy and the
customer organization's configured retention policy. Device revocation prevents
new relay work immediately; signed task leases and Skill rollouts remain
auditable as immutable receipts.

- Privacy: `https://www.dharma-ai.io/privacy`
- Terms: `https://www.dharma-ai.io/terms`
- Support: `https://www.dharma-ai.io/support`
