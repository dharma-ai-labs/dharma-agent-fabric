# `@dharma-ai-labs/agent-fabric-sdk`

Organization-scoped TypeScript client for Dharma-managed, local BYOK, and GCP
Vertex BYOK Agent Fabric APIs. Customer tokens authenticate only to Dharma HQ;
the SDK does not return provider credentials, private runtime URLs, or customer
cloud identities.

```ts
import { AgentFabricClient } from '@dharma-ai-labs/agent-fabric-sdk';

const fabric = new AgentFabricClient({
  baseUrl: 'https://www.dharma-ai.io',
  organizationId: process.env.DHARMA_ORGANIZATION_ID!,
  token: process.env.DHARMA_ORG_API_TOKEN!,
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

- [OpenAPI contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/openapi/agent-fabric.openapi.json)
- [Managed runtime, BYOK, and billing](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/09-managed-runtime-byok-and-billing.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/sdk)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
