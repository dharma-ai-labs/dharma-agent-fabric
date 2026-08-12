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
```

- [OpenAPI contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/openapi/agent-fabric.openapi.json)
- [Managed runtime, BYOK, and billing](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/09-managed-runtime-byok-and-billing.md)
- [Source](https://github.com/dharma-ai-labs/dharma-agent-fabric/tree/main/packages/sdk)
- [Dharma AI](https://www.dharma-ai.io)

Licensed under MIT.
