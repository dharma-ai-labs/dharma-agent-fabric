import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { planRepositoryPackageTransfer, planRepositoryPackageTransferV2 } from './repositoryPackageTransfer.js';

const directory = fileURLToPath(new URL('./schemas/', import.meta.url));
const indexSchema = 'https://schemas.dharma-ai.io/repository-package-transfer/v2';
const chunkSchema = 'https://schemas.dharma-ai.io/repository-package-chunk/v2';
const scope = { organizationId: 'org_transfer_schema_fixture',
  repositoryBindingId: 'a24b5a90-3b7a-4a81-9503-c9f49be790c3',
  repositoryAgentId: 'b24b5a90-3b7a-4a81-9503-c9f49be790c3',
  releaseId: 'c24b5a90-3b7a-4a81-9503-c9f49be790c3', generation: 1, gitCommit: 'a'.repeat(40) };
function file(path: string, sizeBytes: number) {
  const bytes = Buffer.alloc(sizeBytes, 65);
  return { path, sizeBytes, contentBase64: bytes.toString('base64'),
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

test('v2 complete capacity and every generated chunk match the public protocol schemas', async () => {
  const files = Array.from({ length: 516 }, (_, index) => file(`skills/schema/${index}.bin`, index < 20 ? 262144 : 0));
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  assert.equal((await validateContract(directory, indexSchema, plan.index)).ok, true);
  for (const chunk of plan.chunks) assert.equal((await validateContract(directory, chunkSchema, chunk)).ok, true);
});

test('v2 public index schema rejects malformed pins, identities, counts and protocol substitution', async () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: [file('skills/schema/a', 1)] });
  for (const key of ['organizationId', 'repositoryBindingId', 'repositoryAgentId', 'releaseId', 'gitCommit'] as const) {
    assert.equal((await validateContract(directory, indexSchema, { ...plan.index, [key]: plan.index[key] + '\n' })).ok, false);
  }
  for (const change of [{ generation: 0 }, { generation: '1' }, { schema: 'dharma.repository-package-transfer/v1' },
    { totalBytes: 5242881 }, { token: 'untrusted' }, { files: [] }, { files: Array(517).fill(plan.index.files[0]) }]) {
    assert.equal((await validateContract(directory, indexSchema, { ...plan.index, ...change })).ok, false);
  }
  const { repositoryBindingId: _binding, generation: _generation, ...legacyScope } = scope;
  const legacy = planRepositoryPackageTransfer({ ...legacyScope, files: [file('skills/schema/a', 1)] });
  assert.equal((await validateContract(directory, indexSchema, legacy.index)).ok, false);
  assert.equal((await validateContract(directory, chunkSchema, legacy.chunks[0])).ok, false);
});

test('v2 public chunk schema rejects extra authority, noncanonical framing and invalid coordinates', async () => {
  const chunk = planRepositoryPackageTransferV2({ ...scope, files: [file('skills/schema/a', 1)] }).chunks[0]!;
  for (const change of [{ indexHash: chunk.indexHash + '\n' }, { fileIndex: 516 }, { chunkIndex: 4 },
    { fileIndex: -1 }, { fileIndex: 0.5 }, { authority: true }, { contentBase64: 'YQ==\n' },
    { contentBase64: 'YQ' }, { contentBase64: 'A'.repeat(87385) }, { schema: 'dharma.repository-package-chunk/v1' }]) {
    assert.equal((await validateContract(directory, chunkSchema, { ...chunk, ...change })).ok, false);
  }
});
