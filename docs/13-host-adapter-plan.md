# Host Adapter Plan

## Source foundation

Better Harness currently distinguishes host support across eight providers:

- Codex
- Claude Code
- Cursor
- Qoder
- Qwen Code
- GitHub Copilot CLI
- Pi
- WorkBuddy

Its strongest reusable discipline is that a host integration is not one adapter. Native discovery, configured assets, session evidence, output, packaging, task execution, and skill activation are separate claims.

## Dharma host slices

| Slice | Meaning |
| --- | --- |
| Evidence source | Workspace-qualified local trajectories can be collected. |
| Configured assets | Skills, rules, hooks, MCP, agents, and plugin state can be inventoried. |
| Task execution | A bounded non-interactive task can be started. |
| Conversation continuation | The relay can send follow-up input to the same task. |
| Cancellation | The relay can stop a task and observe termination. |
| Usage evidence | Model or token usage can be observed without invention. |
| Skill install | The relay can stage the organization Skill. |
| Activation | The host can prove when the new version becomes active. |
| Package/discovery | A public plugin or native extension can be installed and detected. |

## Adapter interface family

```ts
export interface EvidenceAdapter {
  discoverSources(input: DiscoverSourcesInput): Promise<SourceInventory>;
  collectSessions(input: CollectSessionsInput): Promise<SessionPopulation>;
  normalizeSession(input: NormalizeSessionInput): AsyncIterable<AgentEvent>;
}

export interface ConfiguredAssetAdapter {
  inventory(input: AssetInventoryInput): Promise<ConfiguredAssetInventory>;
}

export interface TaskAdapter {
  probe(input: TaskProbeInput): Promise<TaskCapability>;
  prepare(input: PrepareTaskInput): Promise<PreparedTask>;
  run(task: PreparedTask): AsyncIterable<ProviderRuntimeEvent>;
  send(taskId: string, input: AgentInputMessage): Promise<void>;
  cancel(taskId: string): Promise<CancelResult>;
}

export interface SkillHostAdapter {
  planInstall(input: PlanSkillInstallInput): Promise<SkillInstallPlan>;
  stage(plan: SkillInstallPlan): Promise<StagedSkillInstall>;
  verify(staged: StagedSkillInstall): Promise<SkillVerificationResult>;
  activate(staged: StagedSkillInstall): Promise<SkillActivationResult>;
  rollback(input: SkillRollbackInput): Promise<SkillRollbackResult>;
}
```

## Initial support priorities

### Codex

Target v1:

- evidence: full;
- configured assets: full;
- task execution: full after pinned CLI smoke;
- continuation: validate against installed version;
- skill install: full through Codex plugin/Skill locations;
- activation: new task or documented plugin refresh;
- usage: preserve exact available fields, mark missing fields partial.

### Claude Code

Target v1:

- evidence: full;
- configured assets: full;
- task execution: full after native non-interactive smoke;
- continuation: validate;
- skill install: marketplace or local plugin path;
- activation: new session after plugin change;
- usage: use observed native fields only.

### Cursor

Target v1:

- evidence: full when workspace transcripts exist;
- configured assets: full;
- task execution: partial until native source-local non-interactive behavior is validated;
- skill install: source-local plugin or project assets;
- activation: next agent session;
- usage: partial when transcript/audit join is incomplete.

### Qoder

Target v1.1:

- evidence and configured assets based on Better Harness;
- task execution and continuation require native validation;
- skill activation follows Qoder plugin behavior.

### Qwen, Copilot CLI, Pi, WorkBuddy

Target v1.1 or later. Land evidence and Skill support independently from task execution.

## Windows and WSL

Windows and WSL adapters must not combine data by default.

- Native Windows Cursor sessions belong to the Windows device.
- WSL Codex or Claude sessions belong to the WSL device.
- A Windows relay may optionally observe approved mounted repositories, but it must not double-ingest sessions already owned by the WSL relay.
- Repository identity and event hashes support deduplication across devices without merging authority.

## Version contract

Each adapter records:

- observed provider version;
- supported version range;
- source and invocation evidence;
- unavailable fields;
- last native smoke date;
- fixture version.

Unknown major versions degrade capability to `partial` or `unavailable` until validated.

## Privacy contract

Adapters must:

- qualify sessions to workspace before content hydration;
- preserve unknown events as metadata or explicit omission;
- avoid reading undocumented global databases when a supported source exists;
- never serialize secret values;
- keep user-global configured assets separate from workspace activity;
- represent missing token usage as unknown, not zero.

## Host acceptance ladder

1. Deterministic fixtures.
2. Positive and negative workspace binding.
3. Path, Unicode, case, and symlink tests.
4. Secret-leakage tests.
5. Native source discovery smoke.
6. Native configured-asset smoke.
7. Native session capture smoke.
8. Evidence capsule end-to-end.
9. Task execution smoke when claimed.
10. Skill install and activation smoke.
11. Cross-platform CI.
12. Public support declaration updated.

A host appears in public Quickstart only after its claimed end-to-end path passes.
