# Managed Runtime, BYOK, and Billing

## Two execution modes

### Dharma-managed execution

Dharma supplies:

- isolated compute;
- coding-agent runtime;
- model access;
- orchestration;
- tools;
- trajectory capture;
- evaluation;
- remediation;
- held-out validation;
- storage and delivery.

The customer pays Environment Tokens for the actual managed execution and Analysis Tokens for semantic judge or remediation work when those are separated in pricing.

### BYOK and local execution

The customer supplies:

- local provider subscription or authenticated CLI;
- customer-cloud model credentials where applicable;
- local or customer-hosted compute.

Dharma supplies:

- local relay and capture;
- organization control plane;
- deterministic analysis;
- orchestration;
- skill distribution;
- audit and customer deliverables.

Dharma charges model-related tokens only when Dharma invokes an LLM for a named analysis purpose.

## BYOK credential boundary

- Local provider credentials remain local.
- The relay invokes the installed provider normally.
- The server receives provider and model metadata only when available and permitted.
- Customer-cloud API keys are stored in the customer's configured secret boundary or a dedicated BYOK vault.
- Dharma does not convert a local provider subscription into a general-purpose API credential.

## Metered purpose classes

### No Dharma model charge

- local provider execution;
- local filtering and compression;
- deterministic schema checks;
- deterministic policy checks;
- deterministic test and Git analysis;
- skill download and installation;
- receipt validation;
- ordinary control-plane metadata operations.

These may be included in a platform subscription or infrastructure allowance.

### Analysis Token charge

- semantic trajectory judge;
- custom rubric proposal;
- semantic failure clustering;
- remediation synthesis;
- held-out LLM judge;
- clean-room scenario generation;
- cross-trajectory organizational analysis;
- semantic report generation beyond included allowance.

### Environment Token charge

- managed coding-agent task;
- managed evaluation agent;
- managed replay environment;
- hosted model inference;
- managed tool execution;
- sandbox compute;
- managed artifact processing.

## Usage event

Every billable event includes:

- organization;
- workspace and task when applicable;
- execution mode;
- purpose class;
- model and provider;
- input, output, cache, and reasoning tokens when available;
- compute duration and class;
- storage and egress where priced;
- estimated cost before execution;
- actual cost after execution;
- hard-cap decision;
- customer payer and cost center;
- source event and audit receipt.

## Hard caps

Support:

- per request;
- per task;
- per evaluation run;
- per device;
- per workspace;
- per day;
- per billing period;
- per model;
- per purpose class.

A cap can:

- reject;
- require approval;
- downgrade model;
- move to deterministic-only analysis;
- postpone;
- switch from managed to BYOK when allowed.

Never silently exceed a cap because a task is already running. The task policy must define whether the current step can finish.

## Cost estimate

Before a semantic or managed run, provide:

- expected model and environment;
- expected token and compute range;
- maximum authorized cost;
- whether cache is expected;
- fallback behavior;
- who pays;
- whether the run is customer-visible.

## Billing integration

Integrate with the existing organization control plane and token ledger rather than creating an independent billing system.

Add distinct event classes such as:

```text
agent_fabric_managed_task
agent_fabric_managed_replay
agent_fabric_judge
agent_fabric_rubric_authoring
agent_fabric_remediation_synthesis
agent_fabric_scenario_generation
```

Keep CC-01 Agent Fabric economics separate from CC-02 RAG and chat credits even if a common internal credit unit exists.

## Pricing model for pilots

A practical pilot can include:

- fixed monthly platform fee;
- included connected developers and repositories;
- included deterministic analysis;
- included storage and control-plane allowance;
- metered Analysis Tokens;
- metered Environment Tokens;
- explicit hard cap;
- one remediation cycle and deliverable.

Do not describe local BYOK provider use as free. It is customer-paid outside Dharma, while Dharma's platform and analysis remain commercial services.

## Cost transparency

The customer console must show:

- local BYOK tasks;
- managed tasks;
- deterministic versus semantic analysis;
- token and environment cost by purpose;
- estimated versus actual;
- remaining hard cap;
- skill remediation cost;
- cost per accepted remediation;
- cost per connected developer and repository.
