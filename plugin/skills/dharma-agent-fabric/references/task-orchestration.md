# Task Orchestration

## Inspect compatible local agents

Use the remote app to list online devices, workspaces, providers, capabilities, active tasks, and pinned Skill bundles.

## Create a task

A task must state:

- exact workspace;
- provider or capability selector;
- instructions;
- read and write paths;
- approved command names;
- network policy;
- Git authority;
- timeout and lease;
- acceptance commands;
- required artifacts;
- execution and billing mode;
- maximum Dharma cost.

Default Git authority is `task_branch`. Never assume merge or deployment authority.

## Follow up

Send follow-up messages through the task conversation. Do not create a second task merely to answer a question from the first agent.

## Completion

Require final commit, task branch, diff hash, validation results, trajectory IDs, pinned Skill bundle, unresolved issues, and cost receipt.
