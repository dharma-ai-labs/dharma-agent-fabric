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

process.stdout.write(`${JSON.stringify({ ok: true, schemas: names.length })}\n`);
