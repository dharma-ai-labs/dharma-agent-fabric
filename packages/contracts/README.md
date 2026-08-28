# `@dharma-ai-labs/agent-fabric-contracts`

Versioned TypeScript contracts and validators for Dharma Agent Fabric protocol
envelopes, provider capabilities, evidence requests, signed tasks, and receipts.
Schema validity establishes structure and integrity; it does not prove factual
grounding or reasoning validity.

## Action-decision receipts

`dharma.action-decision-receipt/v1` is a short-lived receipt signed by a named
KMS key version. It carries exactly one `release`, `block`, `escalate`, or
`withhold` outcome and binds the decision to the organization, task, action,
endpoint, workspace, evaluation contract, state envelope, evidence references,
and canonical SHA-256 task-action digest. Receipts may live for at most 30
minutes.

Use `actionDecisionDigest()` over `dharma.task-action/v1` and verify the embedded
`{ id, actionDigest, receipt, signature, keyVersion }` with
`verifyActionDecisionReceipt()`. `buildActionDecisionAcknowledgement()` emits
the HQ enforcement payload with an `executed`, `contained`, or `unknown`
disposition. The acknowledgement is returned inside the existing signed device
protocol channel.

- [API and event contracts](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/12-api-and-event-contracts.md)
- [API and event contracts](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/12-api-and-event-contracts.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/contracts)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
