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

## Codex task observations

`dharma.codex-task-observation/v1` binds one logical named-session work item to
its exact retained capture, source and result snapshots, signed repository
package, evidence consent, and an independently signed outcome. The record
contains hashes and identities; raw source, conversation content, credentials,
and private graders are retained separately under their applicable policies.

Use `codexTaskLogicalRequestId()` to preserve identity across provider retries.
`verifyCodexTaskObservation()` checks the device signature, current enrollment
and consent, authoritative retained evidence, package hashes, grading contract,
and independent grader signature. The grader key must differ from the device
key. Failed and interrupted work can retain failed outcomes; they cannot claim
a passing grade. The provider's requested model remains separate from its
unreported executed model, and replay is explicitly task-level.

The caller must obtain verification inputs from enrollment, authorized evidence
storage, and trusted grading records rather than echoing the observation's
declarations. Verification does not store or count an observation, deduplicate
intake, or perform evaluation, canary, publication, or rollback. Those runtime
integrations and real Codex qualification remain required before learning can
be reported as operational.

- [API and event contracts](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/12-api-and-event-contracts.md)
- [API and event contracts](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/12-api-and-event-contracts.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/contracts)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
