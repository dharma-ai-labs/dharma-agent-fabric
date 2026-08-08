import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';

const contract = JSON.parse(await readFile(new URL('../openapi/agent-fabric.openapi.json', import.meta.url), 'utf8'));
await SwaggerParser.validate(contract);
assert.equal(contract.openapi, '3.1.0');
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/onboarding']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/conversations']?.post);
assert.ok(contract.paths['/api/v1/orgs/{orgId}/agent-fabric/byok/gcp']?.post);
assert.ok(contract.paths['/api/orgs/{orgId}/agent-runs']?.post);
assert.ok(contract.components.securitySchemes.organizationToken);
assert.equal(JSON.stringify(contract).includes('serviceAccountKey'), false);
assert.equal(JSON.stringify(contract).includes('runtime_url'), false);
process.stdout.write('Agent Fabric OpenAPI contract verified.\n');
