# `@dharma-ai-labs/agent-fabric-provider-adapters`

Capability-scoped local adapters for Codex, Claude Code, Agy, and Hermes Agent. Each adapter
reports evidence discovery, task execution, continuation, Skill installation,
activation, rollback, and usage support independently. Evidence support never
implies that another capability is available. Agy 1.1.13 remains limited to
partial read-only execution and evidence. Agy 1.1.15 adds content-bound Skill
activation and transactional rollback through the Dharma CLI, but consequential
task effects remain unavailable because Agy still lacks path- and command-scoped
effect acknowledgements.

Hermes 0.20.4 uses its supported redacted JSONL session export, safe-mode
one-shot task interface, project Skill trust command, and local Skill listing.
The adapter permits read-only tasks only after Hermes reports a configured
inference provider. Skill discovery and activation do not imply that model
execution is configured.

- [Released host capability evidence](https://github.com/dharma-ai-labs/dharma-agent-fabric#initial-host-support)
- [Customer onboarding](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/provider-adapters)
- [Dharma AI](https://www.dharma-ai.io)

The experimental retained Codex app-server session bridge is qualified on Linux
only. Native Windows probes accepted a permission-profile declaration without
enforcing it when the sandbox was not configured; the configured sandbox did not
pass the permitted-read control. Other hosts therefore fail before provider
dispatch with `codex_session_sandbox_unqualified`. Do not widen filesystem access
or disable the sandbox to work around this gate. This restriction does not change
ordinary enrollment, relay startup, or the separate provider task interfaces.

Named local Codex work retains the exact `turn/start` request and bounded,
exact-thread/turn notifications in the encrypted local vault. Version 2 captures
bind that request's text, workspace and restricted permission profile by hash;
version 1 notification-only captures remain readable. Work prompts containing
recognizable credentials are rejected before intent persistence or dispatch.
Its success or failure receipt references hashes and explicit coverage; raw
requests and notifications are never added to CLI output.
Early events are attributed only after the provider identifies the turn.
Missing scope, excluded credentials, interrupted turns and capture limits remain
visible limitations. Existing raw-evidence retention applies to these captures.

The approved evidence outbox includes the request under the existing disclosure
policy. This is request-and-notification evidence, not retained session context,
verified skill adoption or an attestation of the execution model.
`acceptedLearningObservation` remains `false`: local
completion and capture do not establish server intake, an automatic policy
counter, a replay evaluation, canary approval or a signed learning release.

Licensed under MIT.

## Task Knowledge Transport

The task-local knowledge server uses MCP SDK server 2.3.0 over stdio, with a fresh
server factory for each transport and an explicit 1,024-element raw tool-input
budget. The existing document, page and response limits remain in force. The
normal valid client continues after an oversized request is rejected; separate
stdio clients retain their own receipt-pinned catalog scope.

This adapter does not expose an HTTP transport or bearer-authentication endpoint.
These tests do not qualify an HTTP deployment, shared HTTP transport, audience
validation or HTTP body limits. Introducing such a deployment requires separate
transport and authorization qualification, not reuse of stdio evidence.

## Optional Execution Qualification

`executeProviderTask({ qualification, ... })` can return a local
`qualificationReceipt`. The declaration contains organization/task identity and
SHA256 pins for the input, candidate and separately held oracle receipt. Optional
file-root, skill-root, settings and context pins are explicit hashes or `null`.
Only exact data properties are accepted; raw configuration, paths and executable
declarations are rejected. Declaration pins are caller claims, not independently
verified content or permission to disclose the oracle to the executing provider.

The receipt hashes the actual adapter invocation's argv, stdin, workspace,
registered-command list and environment overrides, plus final output hashes and
failure/timeout disposition. An explicitly configured model argument is hashed;
the actual effective model/settings remain unverified. No user configuration is
read to manufacture a qualification, and no setting, permission, model selection
or provider command is changed by this option. It is not a signed attestation.
Injected runners are labelled separately from the default process runner.

Effective file/skill roots, tool-policy enforcement, fresh context and independent
oracle custody always remain explicitly unverified. A Git worktree is not full
context isolation. A supplied settings or custody hash does not establish those
facts; independent qualification and custody are still required for comparisons.
Runner rejection propagates without a fabricated completion receipt or retry.
The schema is `schemas/provider-execution-qualification.schema.json` in the
repository. Omission preserves the legacy result and execution behavior.
