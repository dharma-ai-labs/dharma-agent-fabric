# Evaluation, Remediation, and Failure Atlas

> **Implementation status:** The evaluation model below is the product contract. Current HQ deterministic analysis is narrower: it detects secret-boundary violations, missing redaction receipts, partial or empty evidence, and runtime-failure signals. Current semantic analysis returns rubric proposals, failure clusters, and unvalidated remediation hypotheses after trajectory capture. It does not make a real-time release decision. See [Runtime truth and semantic escalation](23-runtime-truth-and-semantic-escalation.md).

## Objective

Turn real organization trajectories into precise failure identities, custom evaluation criteria, verified remediation candidates, signed skill releases, and measurable post-rollout outcomes.

## Evaluation object

The evaluated object is the complete task episode:

```text
request and instructions
  -> workspace and skill state
  -> agent decisions
  -> tool calls and repository mutations
  -> validation and delivery state
  -> handoffs to other agents or systems
  -> observed outcome
```

A final response or diff is only one part of the evidence.

## Evaluation layers

### Layer 1: deterministic checks

Use for:

- schema validity;
- required evidence presence;
- workspace binding;
- command and path authority;
- tests and lint results;
- branch and commit state;
- required skill version;
- state transitions;
- tool call correctness where rules are explicit;
- release and rollback receipts;
- hidden-truth assertions;
- cost and hard-cap enforcement.

### Layer 2: semantic judges

Use only when deterministic evaluation cannot answer the question, such as:

- whether the agent misunderstood a nuanced task;
- whether a conclusion follows from evidence;
- whether a handoff preserved intent;
- whether a remediation addresses the actual failure;
- whether a custom rubric needs semantic interpretation;
- whether an agent overclaimed completion.

Every judge run records model, model provider, prompt version, input hashes, output, confidence, token usage, cost, and evaluator revision.

### Layer 3: human review

Required for:

- contested high-impact findings;
- new R3 or R4 authority;
- customer-specific legal or security interpretation;
- ambiguous business outcomes;
- release approval where policy requires it.

## Failure identity

A failure record distinguishes:

- agent-origin failure;
- handoff failure;
- environment or tool failure;
- mixed cause;
- unresolved cause.

It includes:

- observed condition;
- expected condition;
- evidence references;
- affected state, perception, inference, action, authority, or delivery stage;
- severity and confidence;
- reproduction route;
- scope and applicability limits;
- responsible owner;
- current workaround;
- business or engineering consequence.

## Organization-specific rubric authoring

The rubric authoring service receives:

- organization policy;
- repository instructions;
- selected trajectories;
- known good and bad examples;
- task and delivery expectations;
- authority rules;
- hidden truth when applicable;
- existing skill and evaluator versions.

It proposes:

- rubric dimensions;
- deterministic verifiers;
- semantic judge criteria;
- required evidence;
- scoring and failure gates;
- confidence and missing-evidence behavior;
- held-out scenarios;
- promotion criteria.

The output is a versioned proposal. It does not become active until reviewed and validated.

## Comparative and causal claims

A same-model direct-versus-stateful comparison is useful but does not automatically establish isolated causality.

A causal claim requires, where applicable:

- same model and sampling configuration;
- same task inputs;
- same tools and environment;
- same retry policy;
- same context except the named intervention;
- hidden truth outside the agent context;
- reliable deterministic or calibrated scoring;
- repeated trials;
- balanced assignment;
- uncertainty reporting;
- relevant ablations;
- held-out validation;
- post-release observation for real outcome claims.

Without those controls, report comparative behavior only.

## Failure Atlas

The customer-specific Failure Atlas stores:

- failure family;
- normalized signature;
- examples and counterexamples;
- detection logic;
- evidence boundary;
- causes and unresolved causes;
- candidate and accepted remediations;
- historical and held-out results;
- rollout and rollback history;
- recurrence;
- applicability conditions;
- data rights and reuse permissions.

Record count is not the value. Value is demonstrated by better detection, faster diagnosis, lower recurrence, lower human correction, or restored outcomes.

## Cross-customer learning

Customer data remains isolated by default. Cross-customer use requires express contractual authorization for a defined derived-learning category.

Permitted derived artifacts may include:

- generalized failure structures;
- de-identified evaluator patterns;
- clean-room synthetic scenarios;
- non-customer-specific verifier methods.

They must exclude raw traces, identifiable examples, proprietary workflow logic, and reasonably reversible derivatives. Reuse in a new customer context requires held-out validation.

## Remediation candidate generation

Candidate changes may target:

- a shared Skill;
- repository-specific instructions;
- tool selection;
- validation commands;
- handoff schema;
- task routing;
- evidence collection;
- prompt or policy;
- hook configuration;
- runtime gate;
- code, when the customer explicitly authorizes code remediation.

The candidate includes a causal theory and smallest responsible owner.

## Validation ladder

1. Static structure and policy validation.
2. Historical replay on known failures.
3. Matched retest.
4. Held-out evaluation.
5. Regression suite.
6. Security and authority review appropriate to risk.
7. Signed canary release.
8. Current-world post-release re-verification.
9. Outcome-window comparison.

A generated change is not a verified remediation before the applicable ladder passes.

## Post-rollout measures

- target failure recurrence;
- time to verified recovery;
- manual correction burden;
- task completion quality;
- validation pass rate;
- unauthorized action rate;
- false block rate;
- remediation-induced regression;
- provider-specific differences;
- repository-specific differences;
- customer-owned operational outcome.

## Remediation package

Each completed cycle produces:

```text
remediation-package/
├── executive-scorecard.pdf
├── failure-atlas.html
├── failure-atlas.json
├── trajectory-evidence/
├── evaluation-contract.json
├── remediation-summary.md
├── skill-diffs/
├── skill-bundle.json
├── historical-results.json
├── held-out-results.json
├── regression-results.json
├── canary-results.json
├── installation-receipts.json
├── post-rollout-delta.json
└── rollback-manifest.json
```

The executive artifact states what changed, what did not change, what the evidence proves, what remains unknown, and the operational or business outcome tracked.
