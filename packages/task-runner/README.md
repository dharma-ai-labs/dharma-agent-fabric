# `@dharma-ai-labs/agent-fabric-task-runner`

Signed, leased, policy-bound execution for local Agent Fabric tasks. Tasks run
in relay-owned Git worktrees using registered command IDs and canonical
arguments under explicit path, network, Git, budget, and Skill-pin authority.
It is not a general remote shell.

## Receipt-required tasks

A signed task opts into action-time authorization with
`requiredCapabilities: ["action_decision_receipts_v1"]` and a UUID
`target.endpointId`. HQ embeds exactly one task-level decision as
`actionDecision: { id, actionDigest, receipt, signature, keyVersion }` in the
signed task. `executeTask()` verifies and consumes that decision immediately
before provider or acceptance execution. Missing, expired, mismatched,
unknown-key, replayed, or non-release receipts fail closed before any effect.

The default `FileActionDecisionReplayGuard` atomically consumes each decision ID
once under the relay state directory. A gated task receipt includes one HQ
enforcement acknowledgement: `executed` after complete execution, `unknown`
after an indeterminate release attempt, or `contained` for a valid non-release.
Tasks that omit the capability retain the previous behavior and receipt shape.

- [Task execution boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/06-task-execution-and-a2a.md)
- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/task-runner)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
