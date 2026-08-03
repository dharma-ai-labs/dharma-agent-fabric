# Open-Source and Upstream Strategy

## License basis

QoderAI/better-harness is distributed under the MIT License. Dharma may use, modify, merge, publish, distribute, sublicense, and sell derived software, provided the copyright and permission notice remain in copies or substantial portions.

The package includes the upstream license in `starter-scaffold/LICENSES/Qoder-Better-Harness-MIT.txt`.

## Recommended fork model

Use an upstream-friendly fork rather than copying selected files without history.

```text
origin    git@github.com:dharma-ai-labs/dharma-agent-fabric.git
upstream  https://github.com/QoderAI/better-harness.git
```

Keep the inherited source in a recognizable boundary or preserve commit history through the fork.

## What to reuse

- provider source discovery;
- workspace qualification;
- configured-asset adapters;
- session normalization helpers;
- frozen evidence-bundle concepts;
- parser-safe CLI conventions;
- host support evidence discipline;
- finding-bound repair topology checks;
- packaging and cross-platform testing patterns.

## What Dharma must own

- local encrypted vault;
- continuous watchers;
- adaptive deep sync;
- remote protocol;
- device enrollment;
- server-initiated task runner;
- A2A client;
- organization policy;
- signed skill supply chain;
- multi-tenant server ingestion;
- evaluation and remediation services;
- billing;
- GitHub App;
- MCP app;
- organization deliverables.

## Upstream modification rule

Prefer adapters and wrappers. Modify upstream-derived code only when:

- the capability is required for continuous operation;
- an adapter cannot express it without duplicated parsing;
- tests preserve existing behavior;
- the change can plausibly be offered upstream when generic.

## Upstream sync procedure

1. Fetch upstream.
2. Review upstream changelog and security-impacting commits.
3. Merge into a dedicated `upstream-sync/<date>` branch.
4. Run Better Harness tests unchanged.
5. Run Dharma adapter compatibility tests.
6. Inspect provider source-layout changes.
7. Re-run native host smokes.
8. Record conflicts and intentional divergence.
9. Merge only after package and secret-boundary tests pass.

## Public versus private boundary

### Public

- CLI and relay;
- provider adapters;
- schemas;
- local vault implementation;
- local filtering;
- task and Skill protocol client;
- public Skill and plugin metadata;
- sample policies;
- local diagnostics.

### Private

- proprietary rubric prompts;
- organization Failure Atlas;
- cross-trajectory clustering methods that constitute proprietary IP;
- customer skill repositories;
- remediation engine internals;
- managed environment orchestration;
- billing and commercial controls;
- customer evidence and reports.

## Contribution policy

Require contributions to declare:

- provider and version;
- claimed support slices;
- fixtures and native evidence;
- privacy impact;
- path and cross-platform behavior;
- public API impact;
- generated artifacts;
- upstream-derived files;
- AI involvement and human verification.

## Trademark and naming

Do not imply endorsement by Qoder. Retain factual attribution to Better Harness and Qoder in notices and documentation.
