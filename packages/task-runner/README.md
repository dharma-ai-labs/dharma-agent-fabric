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

## Required Artifacts

`acceptance.requiredArtifacts` names workspace-relative regular files that must
be present and readable after the provider and registered acceptance commands,
before the runner records completion. References use `/` separators, must be
within signed read authority, and cannot contain traversal, empty segments,
wildcards, Windows device names or ambiguous platform-specific aliases.
Invalid or unauthorized references are rejected before provider execution.
The signed required-file list is included as data in provider instructions;
callers do not have to repeat it in their natural-language request.

Artifact sets use conservative portable names: distinct entries cannot collide
after NFC normalization and lowercase conversion, even on case-sensitive hosts.
Exact repeated entries are deduplicated. Windows device-name restrictions include
the superscript COM/LPT aliases. Components are limited to 255 UTF-8 bytes.
Resolved paths are limited to 259 UTF-16 units on Windows (without changing
long-path settings), 1023 UTF-8 bytes on macOS and 4095 on Linux. These supported
runner limits do not establish every filesystem or registered tool's limits.

Missing, unreadable, non-file, symbolic-link/junction or hard-linked artifacts
fail acceptance. Artifact contents and target paths are not copied into failure
messages. Empty regular files satisfy presence, not quality; an empty required
list preserves existing behavior. A late failure after released work retains an
`unknown` action acknowledgement rather than claiming containment or execution.

This is a final-state completion check, not an OS sandbox, immutable artifact
snapshot, quality grader or proof of external effects. It does not prevent all
concurrent filesystem mutation; native containment and independent acceptance
remain separate requirements.

- [Task execution boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/06-task-execution-and-a2a.md)
- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/task-runner)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
