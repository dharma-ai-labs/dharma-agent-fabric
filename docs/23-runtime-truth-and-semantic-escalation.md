# Runtime Truth and Semantic Escalation

This page records the implementation boundary at public Agent Fabric commit `dfc56ab2cbd2174f876ce8bc0892bc070b17d25f` and HQ commit `d2cac3ada17f0216426b3bde90c7b60252ef0c66`. Product contracts in other design documents remain targets where this page says **planned**.

## Current runtime model

| Surface | Current behavior | Claim boundary |
| --- | --- | --- |
| Local execution gate | Verifies a signed task's identity, organization and workspace, device/provider target, signature, expiry, replay nonce, paths, registered commands, network policy, Git mode, budget, lease, pinned Skill, and relay-owned worktree isolation. | Deterministic authority enforcement, not semantic judgment of rationale. |
| A2A state envelope | Required only for `a2a_handoff`; carries intent, evidence used, known and missing state, allowed and blocked actions, delegated authority, and tool results. | Structured claims and authority, not proof that reasoning is valid. There is no current `final_action` field. |
| A2A orchestration | Same organization, same workspace, different active local endpoint, structured response type, bounded evidence references, and read-only/no-network authority by default. | Bounded task handoff, not arbitrary agent chat, shell, merge, deploy, or cross-tenant access. |
| Deterministic trajectory analysis | Detects secret-boundary violations, missing redaction receipts, partial or empty evidence, and runtime-failure signals. | It does not currently score evidence sufficiency or logical validity. |
| Analysis windows | Closes bounded windows, persists deterministic artifacts, checks semantic-analysis configuration and billing, and optionally invokes the semantic judge. Default exact remediation window is 100 trajectories. | Post-trajectory processing, not an in-flight decision gate. |
| Semantic judge | Returns rubric proposals, failure clusters, and unvalidated remediation hypotheses from bounded redacted evidence. | No current `accept`, `withhold`, `revise`, or `escalate` action decision. |
| Remediation | Exact 100-trajectory windows can feed candidate generation. Managed automation requires 20 non-source held-out trajectories before eligible promotion. | A hypothesis or generated diff is not a verified improvement. |
| Rollout | The first approved release establishes organization policy. Later R0-R2 releases may advance after held-out, regression, security, and canary gates; R3-R4 remain approval-bound. | Every release remains signed, versioned, receipted, and rollback-capable. |

## Two different control points

The current local result is whether a signed task is authorized to execute inside the declared boundary. It is deterministic and immediate.

The current semantic analysis occurs after trajectory capture. It proposes rubrics, groups failures, and suggests remediation hypotheses. Those outputs inform the Failure Atlas and release workflow, but they are not a real-time authorization for the agent's proposed action.

Do not describe either step as proof of Correct Perception, Valid Reasoning, or Ethical Response without an evaluation contract and corresponding evidence.

## Proposed real-time semantic escalation

Real-time semantic escalation is a future contract, not a current Agent Fabric API. A fail-closed implementation should:

1. Freeze the exact proposed action and minimize the evidence envelope.
2. Authenticate tenant, workflow, actor, authority, evidence revisions, and expiry.
3. Run deterministic preflight for schema, identity, freshness, replay, hard rules, and required evidence.
4. Submit only the unresolved semantic question to a versioned evaluator.
5. Aggregate deterministic results, semantic findings, uncertainty, and human authority under a versioned policy.
6. Return a signed, action-bound decision receipt with an explicit outcome, expiry, idempotency key, evidence identity, policy and rubric versions, and correlation ID.
7. Require the receiving system to acknowledge enforcement before the transition is treated as released.
8. Withhold on timeout, stale evidence, unavailable dependencies, mismatched identity, or missing authority unless an explicit human break-glass path applies.

The proposed interface must not expose hidden truth, provider credentials, private runtime URLs, or raw local trajectories. Until it is implemented and proven end to end, it must be labeled **planned**.

## Source ownership

- `dharma-ai-labs/dharma-agent-fabric` owns local contracts, provider adapters, vault, task execution, Skill installation, and public CLI behavior.
- `BobConscious/dharma-ai` owns organization-scoped APIs, orchestration, analysis windows, semantic analysis, Failure Atlas, remediation automation, rollout policy, billing, and portal behavior.
- `dharma-ai-labs/dharmamegha` owns durable Cognitive Integrity doctrine and target contracts. A proposed doctrine does not prove current implementation.
