import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { executeProviderTask, hasVerifiedCodexKnowledgeRead } from './index.js';
import { readVerifiedTaskDocument, type TaskKnowledgeScope } from './knowledge-server.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function fixture(definition = 'A verified progression of signed releases.') {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-task-mcp-'));
  const directory = resolve(workspace, '.dharma-task-knowledge');
  await mkdir(directory, { mode: 0o700 });
  const manifest = JSON.stringify({ files: [{ path: '.agents/skills/shared/SKILL.md', role: 'skill' }] });
  const catalog = JSON.stringify({ concepts: [{ conceptId: 'concept_lifecycle', canonicalName: 'Lifecycle',
    aliases: ['release flow'], definition,
    sources: [{ sourceId: 'source_1', sourceHash: hash('source'), firstLine: 2, lastLine: 3, quote: 'Signed releases' }] }],
  unresolved: [{ conceptId: 'concept_lifecycle', reason: 'conflicting_definition' }] });
  await writeFile(resolve(directory, 'MANIFEST.json'), manifest, { mode: 0o400 });
  await writeFile(resolve(directory, 'CATALOG.json'), catalog, { mode: 0o400 });
  const scope: TaskKnowledgeScope = { directory, manifestSha256: hash(manifest), catalogSha256: hash(catalog) };
  return { workspace, directory, manifest, catalog, scope };
}

test('task knowledge stdio tools only expose hash-verified bounded documents', async () => {
  const f = await fixture();
  const client = new Client({ name: 'dharma-task-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dirname, 'knowledge-server.js'), f.directory,
      f.scope.manifestSha256, f.scope.catalogSha256] });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['catalog_concept', 'catalog_search', 'read_document']);
    assert.equal(tools.every(tool => tool.annotations?.readOnlyHint === true), true);
    const read = await client.callTool({ name: 'read_document', arguments: { document: 'manifest', offset: 0, limit: 12 } });
    assert.equal(read.isError, undefined);
    const page = JSON.parse(String(read.content[0]?.type === 'text' ? read.content[0].text : ''));
    assert.equal(page.text, f.manifest.slice(0, 12));
    assert.equal(page.nextOffset, 12);
    assert.equal(page.sha256, f.scope.manifestSha256);
    const search = await client.callTool({ name: 'catalog_search', arguments: { query: 'release flow' } });
    const found = JSON.parse(String(search.content[0]?.type === 'text' ? search.content[0].text : ''));
    assert.equal(found.total, 1);
    assert.equal(found.concepts[0].conceptId, 'concept_lifecycle');
    const concept = await client.callTool({ name: 'catalog_concept', arguments: { conceptId: 'concept_lifecycle' } });
    const detail = JSON.parse(String(concept.content[0]?.type === 'text' ? concept.content[0].text : ''));
    assert.equal(detail.concept.sources[0].sourceId, 'source_1');
    assert.equal(detail.unresolved[0].reason, 'conflicting_definition');
    const invalid = await client.callTool({ name: 'read_document', arguments: { document: '../secret' } });
    assert.equal(invalid.isError, true);
    await rm(resolve(f.directory, 'CATALOG.json'));
    await writeFile(resolve(f.directory, 'CATALOG.json'), '{}');
    const changed = await client.callTool({ name: 'catalog_search', arguments: { query: 'Lifecycle' } });
    assert.equal(changed.isError, true);
    assert.match(String(changed.content[0]?.type === 'text' ? changed.content[0].text : ''), /hash mismatch/);
  } finally {
    await client.close();
    await rm(f.workspace, { recursive: true, force: true });
  }
});

test('oversized concept results fail bounded while document pages remain available', async () => {
  const f = await fixture('large term '.repeat(4_000));
  const client = new Client({ name: 'dharma-task-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dirname, 'knowledge-server.js'), f.directory,
      f.scope.manifestSha256, f.scope.catalogSha256] });
  try {
    await client.connect(transport);
    const oversized = await client.callTool({ name: 'catalog_concept', arguments: { conceptId: 'concept_lifecycle' } });
    assert.equal(oversized.isError, true);
    const page = await client.callTool({ name: 'read_document', arguments: { document: 'catalog', limit: 8_192 } });
    assert.equal(page.isError, undefined);
    assert.ok(String(page.content[0]?.type === 'text' ? page.content[0].text : '').length < 32_768);
  } finally {
    await client.close();
    await rm(f.workspace, { recursive: true, force: true });
  }
});

test('Codex task launch keeps read-only sandbox and binds the exact knowledge server', async () => {
  const f = await fixture();
  try {
    let argv: string[] = [];
    const noRead = await executeProviderTask({ provider: 'codex', workspace: f.workspace, instructions: 'Read shared knowledge.',
      timeoutSeconds: 30, allowedCommandArgv: [], allowWrites: false, taskKnowledge: f.scope,
      runner: async input => {
        argv = input.argv;
        return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      } });
    assert.equal(noRead.exitCode, 1);
    assert.match(noRead.stderr, /task_knowledge_not_read/);
    assert.equal(argv.includes('read-only'), true);
    assert.equal(argv.includes('workspace-write'), false);
    assert.equal(argv.includes('mcp_servers.dharma_task_knowledge.required=true'), true);
    assert.equal(argv.includes('mcp_servers.dharma_task_knowledge.default_tools_approval_mode="auto"'), true);
    const args = argv.find(value => value.startsWith('mcp_servers.dharma_task_knowledge.args='));
    assert.ok(args);
    assert.deepEqual(JSON.parse(args.slice(args.indexOf('=') + 1)).slice(1), [
      f.directory, f.scope.manifestSha256, f.scope.catalogSha256,
    ]);
    await assert.rejects(() => executeProviderTask({ provider: 'codex', workspace: f.workspace,
      instructions: 'Read shared knowledge.', timeoutSeconds: 30, allowedCommandArgv: [],
      allowWrites: true, taskKnowledge: f.scope, runner: async () => { throw new Error('must not run'); } }),
    /bounded read-only/);
    await assert.rejects(() => executeProviderTask({ provider: 'codex', workspace: f.workspace,
      instructions: 'Read shared knowledge.', timeoutSeconds: 30, allowedCommandArgv: [], allowWrites: false,
      taskKnowledge: { ...f.scope, directory: resolve(f.workspace, '..') },
      runner: async () => { throw new Error('must not run'); } }), /bounded read-only/);
    assert.equal(await readVerifiedTaskDocument(f.scope, 'MANIFEST.json'), f.manifest);
  } finally { await rm(f.workspace, { recursive: true, force: true }); }
});

test('a zero-exit Codex answer needs a completed tool result with the pinned hash', async () => {
  const f = await fixture();
  const event = (tool: string, value: unknown, status = 'completed') => JSON.stringify({ type: 'item.completed',
    item: { type: 'mcp_tool_call', server: 'dharma_task_knowledge', tool, status,
      result: { content: [{ type: 'text', text: JSON.stringify(value) }] }, error: null } });
  try {
    const valid = event('catalog_search', { catalogSha256: f.scope.catalogSha256, total: 1 });
    assert.equal(hasVerifiedCodexKnowledgeRead(valid, f.scope), true);
    assert.equal(hasVerifiedCodexKnowledgeRead(event('catalog_search', { catalogSha256: hash('foreign') }), f.scope), false);
    assert.equal(hasVerifiedCodexKnowledgeRead(event('catalog_search', { catalogSha256: f.scope.catalogSha256 }, 'failed'), f.scope), false);
    assert.equal(hasVerifiedCodexKnowledgeRead(JSON.stringify({ type: 'item.completed', item: {
      type: 'agent_message', text: valid } }), f.scope), false);
    const accepted = await executeProviderTask({ provider: 'codex', workspace: f.workspace,
      instructions: 'Read shared knowledge.', timeoutSeconds: 30, allowedCommandArgv: [],
      allowWrites: false, taskKnowledge: f.scope,
      runner: async () => ({ exitCode: 0, signal: null, timedOut: false,
        stdout: Buffer.from(`${valid}\n`), stderr: Buffer.alloc(0) }) });
    assert.equal(accepted.exitCode, 0);
    const denied = await executeProviderTask({ provider: 'codex', workspace: f.workspace,
      instructions: 'Read shared knowledge.', timeoutSeconds: 30, allowedCommandArgv: [],
      allowWrites: false, taskKnowledge: f.scope,
      runner: async () => ({ exitCode: 0, signal: null, timedOut: false,
        stdout: Buffer.from('{"type":"turn.completed"}\n'), stderr: Buffer.alloc(0) }) });
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stderr, /task_knowledge_not_read/);
  } finally { await rm(f.workspace, { recursive: true, force: true }); }
});
