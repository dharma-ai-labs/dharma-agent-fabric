import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = resolve(import.meta.dirname, '..');
const schemaDir = resolve(root, 'schemas');
const names = (await readdir(schemaDir)).filter((name) => name.endsWith('.schema.json')).sort();
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);

for (const name of names) {
  const schema = JSON.parse(await readFile(resolve(schemaDir, name), 'utf8'));
  ajv.addSchema(schema);
}

const runtimeTaskSchema = JSON.parse(await readFile(resolve(root, 'packages/contracts/src/task-envelope.schema.json'), 'utf8'));
const canonicalTaskSchema = JSON.parse(await readFile(resolve(schemaDir, 'task-envelope.schema.json'), 'utf8'));
if (JSON.stringify(runtimeTaskSchema) !== JSON.stringify(canonicalTaskSchema)) {
  throw new Error('Runtime task-envelope schema copy is out of sync with the canonical schema.');
}

for (const name of names) {
  const schema = JSON.parse(await readFile(resolve(schemaDir, name), 'utf8'));
  if (!schema.$id || !ajv.getSchema(schema.$id)) {
    throw new Error(`Schema did not register correctly: ${name}`);
  }
}

const validateSkillBundle = ajv.getSchema('https://schemas.dharma-ai.io/skill-bundle/v1');
const inlineSkillBundle = {
  schema: 'dharma.skill-bundle/v1',
  bundleId: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org_schema_test',
  version: '1.0.0',
  operation: 'install',
  skills: [{
    skillId: 'schema-test',
    version: '1.0.0',
    repository: 'https://github.com/dharma-ai-labs/schema-test.git',
    commit: 'a'.repeat(40),
    contentHash: `sha256:${'b'.repeat(64)}`,
    path: 'skills/schema-test',
    files: [{
      path: 'SKILL.md',
      contentBase64: 'IyBTY2hlbWEgdGVzdAo=',
      sha256: `sha256:${'c'.repeat(64)}`,
    }],
  }],
  riskClass: 'R3',
  targetSelectors: { organizationAgentIds: [], deviceIds: [], workspaceIds: [], providers: ['codex'] },
  activationPolicy: 'next_session',
  rollbackBundleId: '22222222-2222-4222-8222-222222222222',
  evaluationReceiptId: 'schema-test-evaluation',
  bundleHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-08-16T00:00:00.000Z',
  expiresAt: '2026-08-17T00:00:00.000Z',
  signature: 'schema-test-signature',
};
if (!validateSkillBundle?.(inlineSkillBundle)) {
  throw new Error(`Signed inline skill bundle is invalid: ${ajv.errorsText(validateSkillBundle?.errors)}`);
}
if (validateSkillBundle({ ...inlineSkillBundle, approval: { approvedBy: 'user' } })) {
  throw new Error('Skill bundle schema accepted undeclared approval metadata.');
}
if (validateSkillBundle({
  ...inlineSkillBundle,
  skills: [{ ...inlineSkillBundle.skills[0], files: [{ ...inlineSkillBundle.skills[0].files[0], path: '../SKILL.md' }] }],
})) {
  throw new Error('Skill bundle schema accepted a traversing inline file path.');
}

process.stdout.write(`${JSON.stringify({ ok: true, schemas: names.length })}\n`);
