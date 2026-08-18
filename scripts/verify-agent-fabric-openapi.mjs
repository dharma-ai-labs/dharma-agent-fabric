import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';

const contract = JSON.parse(await readFile(new URL('../openapi/agent-fabric.openapi.json', import.meta.url), 'utf8'));
await SwaggerParser.validate(contract);
assert.equal(contract.openapi, '3.1.0');
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/onboarding']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/conversations']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/remediations/{targetId}']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/agents/{agentId}/endpoints']?.post);
assert.equal(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/endpoints'], undefined);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/byok/gcp']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/evaluation-contracts']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions/{decisionId}/enforcements']?.post);
assert.deepEqual(
  contract.components.schemas.ActionDecisionReceipt.properties.outcome.enum,
  ['release', 'block', 'escalate', 'withhold'],
);
assert.deepEqual(
  contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions/{decisionId}/enforcements'].post.security,
  [],
);
assert.equal(
  contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions/{decisionId}/enforcements'].post.operationId,
  'acknowledgeActionDecisionEnforcement',
);
assert.ok(contract.paths['/api/orgs/{orgId}/agent-runs']?.post);
assert.ok(contract.components.securitySchemes.organizationToken);
assert.equal(contract.components.schemas.AgentEndpointRequest.oneOf.length, 2);
assert.deepEqual(
  contract.components.schemas.AgentEndpointRequest.oneOf[1].properties.endpointKind.enum,
  ['managed_runtime', 'cloud_byok'],
);
assert.equal(JSON.stringify(contract).includes('serviceAccountKey'), false);
assert.equal(JSON.stringify(contract).includes('runtime_url'), false);
assert.equal(JSON.stringify(contract.components.schemas.AnalysisRequest).includes('trajectoryIds'), false);
process.stdout.write('Agent Fabric OpenAPI contract verified.\n');
