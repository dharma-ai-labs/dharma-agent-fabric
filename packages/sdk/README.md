# `@dharma-ai-labs/agent-fabric-sdk`

Organization-scoped TypeScript client for Dharma-managed, local BYOK, and GCP
Vertex BYOK Agent Fabric APIs. Customer tokens authenticate only to Dharma HQ;
the SDK does not return provider credentials, private runtime URLs, or customer
cloud identities.

```ts
import { readFile } from 'node:fs/promises';
import {
  AgentFabricClient,
  type AgentFabricManagedEvaluationCampaignInput,
  type AgentFabricManagedEvaluationTaskPackage,
} from '@dharma-ai-labs/agent-fabric-sdk';

const fabric = new AgentFabricClient({
  baseUrl: 'https://www.dharma-ai.io',
  organizationId: process.env.DHARMA_ORGANIZATION_ID!,
  token: process.env.DHARMA_ORG_API_TOKEN!,
});

const taskPackage = JSON.parse(
  await readFile('managed-evaluation-task-package-v1.json', 'utf8'),
) as AgentFabricManagedEvaluationTaskPackage;

const campaign = {
  name: 'Checkout handoff evaluation',
  agentId: '<active-managed-agent-id>',
  arms: ['direct_baseline', 'stateful_dharma_runtime'],
  evaluationContract: taskPackage.evaluation_contract,
  tasks: taskPackage.tasks,
} satisfies AgentFabricManagedEvaluationCampaignInput;

const preflight = await fabric.preflightManagedEval(campaign, {
  idempotencyKey: crypto.randomUUID(),
});
// Review preflight.preflight.maximumCredits before the paid mutation.
const launched = await fabric.createManagedEval(campaign, {
  idempotencyKey: crypto.randomUUID(),
});
const result = await fabric.getManagedEvals({
  campaignId: launched.campaign.id,
});

const staged = await fabric.transitionRemediationTarget('<target-id>', {
  action: 'stage_evaluation',
  endpointId: '<active-local-endpoint-id>',
}, { idempotencyKey: crypto.randomUUID() });

// Install the returned evaluation authorization with `dharma skills sync`,
// then collect 20 to 100 later non-source trajectories on that exact endpoint.
const heldOutTrajectoryIds = [/* candidate-bound trajectory IDs */];
await fabric.transitionRemediationTarget('<target-id>', {
  action: 'run_backtest',
  trajectoryIds: heldOutTrajectoryIds,
}, { idempotencyKey: crypto.randomUUID() });
```

`stage_evaluation` is a short-lived, signed evaluation-only rollout, not release
approval. `run_backtest` accepts only retained trajectories collected after the
candidate bundle was installed on that exact endpoint. It rejects source,
older, cross-endpoint, and differently pinned evidence.

Managed evaluation task packages combine the mandatory standard Cognitive
Integrity gates with an optional versioned customer-domain rubric and bounded
operational criteria. Preflight is read-only and returns exact maximum credits;
the campaign read returns the same persisted verdict consumed by the portal and
Control Agent without exposing scorer-only hidden truth.

- [OpenAPI contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/openapi/agent-fabric.openapi.json)
- [Managed evaluation task package](https://www.dharma-ai.io/docs/evaluations)
- [Managed runtime, BYOK, and billing](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/09-managed-runtime-byok-and-billing.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/sdk)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
