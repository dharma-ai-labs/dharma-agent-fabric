import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse as parseYaml } from 'yaml';

const contract = JSON.parse(await readFile(new URL('../openapi/agent-fabric.openapi.json', import.meta.url), 'utf8'));
const sourceContract = parseYaml(await readFile(new URL('../schemas/openapi-agent-fabric.yaml', import.meta.url), 'utf8'));
const actionDecisionTask = JSON.parse(await readFile(new URL('../schemas/action-decision-task-request.schema.json', import.meta.url), 'utf8'));
const actionDecisionReceipt = JSON.parse(await readFile(new URL('../schemas/action-decision-receipt.schema.json', import.meta.url), 'utf8'));
await SwaggerParser.validate(contract);
await SwaggerParser.validate(sourceContract);
assert.deepEqual(sourceContract, contract, 'JSON and YAML OpenAPI publications must remain identical');
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
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/sessions']?.get);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/sessions']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/sessions/{sessionId}/messages']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/sessions/{sessionId}/events']?.get);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/tool-calls/{toolCallId}/approve']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/control-agent/tool-calls/{toolCallId}/reject']?.post);
assert.deepEqual(
  contract.components.schemas.ActionDecisionReceipt.properties.outcome.enum,
  ['release', 'block', 'escalate', 'withhold'],
);
for (const [schemaName, canonical] of [
  ['ActionDecisionTask', actionDecisionTask],
  ['ActionDecisionReceipt', actionDecisionReceipt],
]) {
  const published = contract.components.schemas[schemaName];
  assert.equal(published.type, canonical.type, `${schemaName} type drifted from its canonical JSON Schema`);
  assert.equal(published.additionalProperties, canonical.additionalProperties, `${schemaName} additionalProperties drifted`);
  assert.deepEqual(published.required, canonical.required, `${schemaName} required fields drifted`);
  assert.deepEqual(published.properties, canonical.properties, `${schemaName} properties drifted`);
  const sourcePublished = sourceContract.components.schemas[schemaName];
  assert.equal(sourcePublished.type, canonical.type, `${schemaName} source type drifted from its canonical JSON Schema`);
  assert.equal(sourcePublished.additionalProperties, canonical.additionalProperties, `${schemaName} source additionalProperties drifted`);
  assert.deepEqual(sourcePublished.required, canonical.required, `${schemaName} source required fields drifted`);
  assert.deepEqual(sourcePublished.properties, canonical.properties, `${schemaName} source properties drifted`);
}
const deviceSignatureSecurity = {
  deviceIdHeader: [],
  deviceSessionHeader: [],
  deviceMessageHeader: [],
  deviceTimestampHeader: [],
  deviceNonceHeader: [],
  deviceSequenceHeader: [],
  deviceSignatureHeader: [],
};
assert.deepEqual(
  contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions/{decisionId}/enforcements'].post.security,
  [deviceSignatureSecurity],
);
assert.deepEqual(
  sourceContract.components.pathItems.actionDecisionEnforcements.post.security,
  [deviceSignatureSecurity],
);
assert.deepEqual(
  Object.fromEntries(Object.keys(deviceSignatureSecurity).map((scheme) => [scheme, contract.components.securitySchemes[scheme]?.name])),
  {
    deviceIdHeader: 'x-dharma-device-id',
    deviceSessionHeader: 'x-dharma-session-id',
    deviceMessageHeader: 'x-dharma-message-id',
    deviceTimestampHeader: 'x-dharma-timestamp',
    deviceNonceHeader: 'x-dharma-nonce',
    deviceSequenceHeader: 'x-dharma-sequence',
    deviceSignatureHeader: 'x-dharma-signature',
  },
);
assert.deepEqual(
  Object.fromEntries(Object.keys(deviceSignatureSecurity).map((scheme) => [scheme, sourceContract.components.securitySchemes[scheme]?.name])),
  {
    deviceIdHeader: 'x-dharma-device-id',
    deviceSessionHeader: 'x-dharma-session-id',
    deviceMessageHeader: 'x-dharma-message-id',
    deviceTimestampHeader: 'x-dharma-timestamp',
    deviceNonceHeader: 'x-dharma-nonce',
    deviceSequenceHeader: 'x-dharma-sequence',
    deviceSignatureHeader: 'x-dharma-signature',
  },
);
assert.equal(
  contract.paths['/api/v1/orgs/{orgId}/agent-fabric/decisions/{decisionId}/enforcements'].post.operationId,
  'acknowledgeActionDecisionEnforcement',
);
assert.deepEqual(
  contract.paths['/api/v1/orgs/{orgId}/control-agent/tool-calls/{toolCallId}/approve'].post.security,
  [{ clerkSession: [] }],
);
assert.equal(contract.components.parameters.afterSequence.name, 'afterSequence');
assert.equal(contract.components.securitySchemes.clerkSession.name, '__session');
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
