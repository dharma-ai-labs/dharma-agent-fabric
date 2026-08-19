# `@dharma-ai-labs/agent-fabric-provider-adapters`

Capability-scoped local adapters for Codex, Claude Code, and Agy. Each adapter
reports evidence discovery, task execution, continuation, Skill installation,
activation, rollback, and usage support independently. Evidence support never
implies that another capability is available. Agy 1.1.13 remains limited to
partial read-only execution and evidence. Agy 1.1.15 adds content-bound Skill
activation and transactional rollback through the Dharma CLI, but consequential
task effects remain unavailable because Agy still lacks path- and command-scoped
effect acknowledgements.

- [Provider and host plan](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/13-host-adapter-plan.md)
- [Customer onboarding](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/provider-adapters)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
