import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { containsDisallowedLocalPath } from '@dharma-ai-labs/agent-fabric-evidence-reduction';

async function fixture(payload: unknown) {
  const session = { sessionId: 'synthetic', endedAt: '2026-09-29T00:00:01.000Z',
    startedAt: '2026-09-29T00:00:00.000Z', coverage: 'observed', records: [{ kind: 'tool_result', native: {} }] };
  const deps = {
    Buffer, canonicalize, sha256, containsDisallowedLocalPath,
    realpath: async (path: string) => path,
    required: (flags: Map<string, string | boolean>, name: string) => flags.get(name),
    providerAdapter: () => ({ discover: async () => [session] }),
    configPath: () => '/fixtures/device.json', readFile: async () => JSON.stringify({ organizationId: 'org_fixture', deviceId: 'device' }),
    registry: async () => [], selectDeviceWorkspace: () => ({ workspaceId: 'workspace' }),
    loadVerifiedWorkspacePolicy: async () => ({ evidence: {} }),
    buildTrajectoryCapsule: () => ({ events: [{ payload: { nativeProviderPayload: payload } }],
      redactionReceipt: { disclosedClasses: [], excludedClasses: [] }, contentIndex: [{ bytes: 1 }],
      automaticDisclosureMode: 'customer_authorized_content' }),
  };
  const sourceText = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'evidencePreview');
  assert.ok(node);
  const compiled = ts.transpileModule(node.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const run = runInNewContext(`${compiled.outputText}\nevidencePreview`, deps,
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as
      (flags: Map<string, string | boolean>) => Promise<{ automaticDisclosure: { ready: boolean; blockedCapsuleCount: number; reasonCodes: string[] } }>;
  return run(new Map<string, string | boolean>([['workspace', '/fixtures/repo'], ['provider', 'codex'], ['policy', '/fixtures/policy.json']]));
}

test('actual evidence preview refuses readiness when a reduced capsule retains a forbidden local path', async () => {
  const result = await fixture({ text: JSON.stringify({ output: 'Synthetic result\n/tmp/leak' }) });
  assert.equal(result.automaticDisclosure.ready, false);
  assert.equal(result.automaticDisclosure.blockedCapsuleCount, 1);
  assert.deepEqual([...result.automaticDisclosure.reasonCodes], ['local_path_disclosure_forbidden']);
});

test('actual evidence preview is fail closed when capsule path inspection exceeds its depth limit', async () => {
  let payload: unknown = '/tmp/leak';
  for (let depth = 0; depth < 70; depth += 1) payload = { nested: payload };
  const result = await fixture(payload);
  assert.equal(result.automaticDisclosure.ready, false);
  assert.deepEqual([...result.automaticDisclosure.reasonCodes], ['local_path_inspection_depth_exceeded']);
});

test('actual evidence preview admits a reduced path-free capsule without leaking payload into its result', async () => {
  const result = await fixture({ text: JSON.stringify({ output: '[REDACTED:local_path]', ok: true }) });
  assert.equal(result.automaticDisclosure.ready, true);
  assert.equal(result.automaticDisclosure.blockedCapsuleCount, 0);
  assert.deepEqual([...result.automaticDisclosure.reasonCodes], []);
  assert.equal(JSON.stringify(result).includes('REDACTED'), false);
});
