import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'schemas');
const destination = resolve(root, 'packages/cli/dist/schemas');
const schemas = (await readdir(source)).filter((name) => name.endsWith('.schema.json')).sort();

if (schemas.length === 0) throw new Error('No Agent Fabric runtime schemas were found.');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await Promise.all(schemas.map((name) => copyFile(resolve(source, name), resolve(destination, name))));
process.stdout.write(`${JSON.stringify({ ok: true, copiedSchemas: schemas.length })}\n`);
