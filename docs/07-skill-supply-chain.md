# Organization Skill Supply Chain

## Objective

Turn organization-wide learning into reviewed, immutable, automatically installed Skills without allowing a mutable branch or server-generated proposal to silently become local agent behavior.

## Repository model

Create one private GitHub repository per customer:

```text
dharma-managed/<customer-slug>-agent-control
```

The repository is owned or managed by the Dharma GitHub App under a contractually agreed organization. Customer access and export rights must be explicit.

## Branch model

```text
main
skill/release-control
skill/testing-contract
skill/database-migrations
skill/frontend-review
skill/security-review
skill/customer-support-handoff
```

Each `skill/<skill-id>` branch is the authoring stream for one Skill. It contains:

```text
skill/
├── SKILL.md
├── manifest.yaml
├── references/
├── templates/
├── tests/
├── evals/
├── adapters/
├── CHANGELOG.md
└── provenance.json
```

## Source and release separation

- Branch heads are mutable authoring state.
- Pull requests provide review and discussion.
- A release candidate names exact commits.
- A signed bundle is immutable distribution state.
- Local agents install bundles, never branch heads.

## Skill manifest

Required fields:

- skill ID and semantic version;
- source commit;
- organization;
- compatible providers;
- supported operating systems;
- installation targets;
- activation behavior;
- required tools and permissions;
- risk class;
- evaluation suite;
- expected output;
- rollback version;
- provenance;
- content hashes.

## Bundle release

A release bundle may include one or more skills so an organization can change a coordinated set atomically.

```text
bundle-2026-08-03.1/
├── bundle.json
├── skills/
│   ├── release-control/
│   └── testing-contract/
├── evidence/
│   ├── historical-results.json
│   ├── held-out-results.json
│   └── regression-results.json
├── signatures/
└── THIRD_PARTY_NOTICES.md
```

The release service:

1. Fetches exact approved commits through the GitHub App.
2. Validates manifests and skill structure.
3. Runs static checks and provider packaging tests.
4. Binds evaluation receipts.
5. Creates a deterministic archive.
6. Calculates content hashes.
7. Signs the bundle.
8. Publishes it to organization-scoped object storage.
9. Records rollback ancestry.
10. Creates a release manifest on `main` or a signed Git tag.

## Risk classes

| Class | Examples | Promotion default |
| --- | --- | --- |
| R0 | Documentation, labels, examples | Automatic after static validation |
| R1 | Narrow instruction clarification with no new authority | Automatic after held-out pass |
| R2 | Tool choice, workflow sequence, validation command | Canary, then automatic if healthy |
| R3 | New repository write path, new network domain, new local command class | Explicit organization approval before release |
| R4 | Merge, deployment, secret, production, or destructive authority | Explicit security and release-owner approval, restricted rollout |

Risk is determined by the effective behavior change, not only the files modified.

## Remediation PR

A remediation pull request must include:

- failure family;
- affected providers, repositories, and cohorts;
- evidence boundary;
- causal hypothesis;
- exact Skill changes;
- historical results;
- held-out results;
- known regressions;
- cost impact;
- intended rollout;
- rollback condition;
- disclosure and reuse boundary.

The remediation producer may not be the sole approver for R3 or R4.

## Automatic installation

### Download

1. Server sends `SkillReleaseAvailable` with bundle ID, target selectors, hashes, signature, activation policy, and rollback bundle.
2. Relay verifies organization, device, workspace, provider, expiry, policy, and signature.
3. Relay downloads to a staging directory.
4. Relay verifies every file hash and manifest.

### Host staging

Each provider adapter maps the bundle into its native Skill or instruction locations. The adapter must distinguish:

- project scope;
- user scope;
- plugin scope;
- generated mirror;
- native discovery metadata.

### Activation

Activation modes:

- `next_task`
- `next_session`
- `host_restart`
- `immediate_safe_reload`

Do not claim immediate activation when the host only reloads Skills on a new session.

### Verification

Provider-specific verification may include:

- plugin or Skill inventory command;
- local manifest inspection;
- a no-op discovery task;
- exact version echo;
- packaging validation;
- a bounded canary prompt.

### Atomic switch

The relay switches an active pointer only after staging and verification pass. On platforms without safe symlink semantics, use versioned directories plus atomic manifest replacement.

## Task pinning

Every task records the bundle active when it starts. A later release does not change the running task's instruction state unless:

- the task explicitly permits an update;
- the provider supports it safely;
- the update is recorded as a new task state transition.

## Rollout strategy

1. Internal Dharma fixtures.
2. One canary device.
3. One canary cohort or repository.
4. 10% of eligible online devices.
5. 50%.
6. 100%.

A low-risk release may compress stages after enough organization evidence exists. R3 and R4 retain deliberate gates.

## Health checks

A rollout checks:

- download and signature success;
- host discovery;
- task startup;
- validation command behavior;
- new error rate;
- task cancellation rate;
- provider incompatibility;
- skill-related user correction;
- target failure recurrence;
- unrelated regression signals.

## Automatic rollback

Rollback triggers include:

- signature or hash mismatch;
- installation failure above threshold;
- host discovery failure;
- canary task failure;
- severe regression;
- authority violation;
- emergency organization action.

Rollback reactivates the prior known-good bundle, verifies it, and returns a signed receipt.

## Installation receipt

Each receipt records:

- device and workspace;
- provider;
- bundle and skill versions;
- previous bundle;
- staging start and end;
- activation mode;
- verification results;
- final state;
- errors;
- rollback state;
- local policy revision;
- relay version;
- signature.

## Organization-wide visibility

The operator console shows:

- authoring branches;
- open remediation PRs;
- released bundles;
- targeted devices;
- installation and activation progress;
- pinned running tasks;
- canary health;
- rollbacks;
- post-rollout outcome evidence.
