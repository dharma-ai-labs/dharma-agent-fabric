# `@dharma-ai-labs/agent-fabric-task-runner`

Local callers may opt into adapter-boundary digest receipts with
`executeTask({ providerQualification, ... })`. Its declared organization/task
must match the already signed task; the option adds no execution authority or
new acceptance gate. It is forwarded to the existing provider executor and the
returned qualification is retained in that provider command's stored result.
A bounded data-only report must match the declaration, provider and outcome;
extra raw fields, accessors and mismatched reports are discarded, not persisted.
An executor report remains a report, not an independent attestation.
A custom executor that does not report valid qualification produces an explicit
`qualificationReceipt: null`, without converting ordinary task success into
qualification success. Existing completed-task replay returns the original
receipt, not a newly labelled observation. The option is not a new signed-task
field, an independent oracle, a context-isolation guarantee or runtime evidence
of the effective model/settings. Omission leaves legacy receipts unchanged.

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
after NFC normalization and Unicode lower/upper/lower mapping, even on
case-sensitive hosts. This catches final-sigma and sharp-S aliases; it is a
conservative admission rule, not an exact implementation of every filesystem's
Unicode version. Both signed envelope schemas cap raw entries at 100 and each
reference at 1,000 Unicode characters. Bounded exact duplicates remain compatible
and are deduplicated; they still count toward the raw-entry cap.
Acceptance commands are capped at 98, reserving the 100-result receipt capacity
for one provider result and one late runner failure. Excess commands are rejected
before effects, rather than losing the durable failure receipt.
Windows device-name restrictions include
the superscript COM/LPT aliases and CONIN$/CONOUT$. Ill-formed Unicode (lone
surrogates) is rejected rather than replaced during filesystem encoding.
Components are limited to 255 UTF-8 bytes.
Resolved paths are limited to 259 UTF-16 units on Windows (without changing
long-path settings), 1023 UTF-8 bytes on macOS and 4095 on Linux. These supported
runner limits do not establish every filesystem or registered tool's limits.

Generated artifact metadata has its own 256,000 UTF-16-unit hard bound, separate
from the existing 20,000-unit task/context instruction limit. This accommodates
the schema's 100 paths of up to 1,000 characters without consuming task text's
allowance. Neither instructions nor signed paths are truncated; provider and
task budget enforcement still applies. Empty lists add no metadata.
Agy/Hermes carry text in argv and fail before process invocation if the complete
argument estimate exceeds 32,760 conservatively quoted UTF-16 units on Windows
or 65,536 UTF-8 bytes elsewhere. Codex/Claude use stdin. These supported limits
do not attest provider acceptance or all operating-system environment limits.

Missing, unreadable, non-file, symbolic-link/junction or hard-linked artifacts
fail acceptance. Artifact contents and target paths are not copied into failure
messages. Empty regular files satisfy presence, not quality; an empty required
list preserves existing behavior. A late failure after released work retains an
`unknown` action acknowledgement rather than claiming containment or execution.

Required paths without signed write authority must already exist before the
provider starts. The runner fingerprints their regular-file metadata and hashes
their contents without exposing either, then checks them after the provider and
after acceptance commands. Ignored files do not gain write authority from being
required artifacts. Write-authorized outputs still use final presence checks.
Git path inventories must be complete and NUL-terminated; exceeding the bounded
capture limit fails closed rather than authorizing a partial inventory.

This is a final-state completion check, not an OS sandbox, immutable artifact
snapshot, quality grader or proof of external effects. The integrity checks do not prevent all
concurrent filesystem mutation; native containment and independent acceptance
remain separate requirements.

- [Task execution boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/06-task-execution-and-a2a.md)
- [Bidirectional protocol](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/05-bidirectional-protocol.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/task-runner)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
