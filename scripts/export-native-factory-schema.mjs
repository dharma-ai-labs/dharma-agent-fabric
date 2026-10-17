import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { nativeFactoryCaptureSchema } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-native-factory';

const target = resolve(import.meta.dirname, '../schemas/codex-native-factory-capture-v1.schema.json');
const expected = JSON.stringify({ ...z.toJSONSchema(nativeFactoryCaptureSchema),
  $id: 'https://schemas.dharma-ai.io/codex-native-factory-capture/v1' }, null, 2) + '\n';
if (process.argv.slice(2).join(' ') === '--write') {
  await writeFile(target, expected, { flag: 'wx' });
} else if (process.argv.length !== 2 || await readFile(target, 'utf8') !== expected) {
  throw new Error('native_factory_schema_drift');
}
console.log(JSON.stringify({ schema: 'dharma.codex-native-factory-capture/v1', state: 'matched' }));
