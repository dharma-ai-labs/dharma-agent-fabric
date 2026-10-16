import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { containsCredential } from './codexTurnCapture.js';
import contextSchema from './named-session-repository-context.schema.json' with { type: 'json' };
import fragmentSchema from './codex-repository-context-fragment.schema.json' with { type: 'json' };

export interface NamedRepositoryContext {
  schema: 'dharma.named-session-repository-context/v1';
  kind: 'signed_repository_material'; authority: 'untrusted_repository_data';
  organizationId: string; workspaceId: string; repositoryBindingId: string; repositoryAgentId: string;
  bundleId: string; bundleHash: string; manifestHash: string; catalogHash: string;
  sourceReceiptId: string; sourceRevision: number; concepts: unknown[]; unresolved: unknown[];
  files: Array<{ path: string; role: 'skill' | 'dependency' | 'knowledge'; sha256: string; sizeBytes: number } & (
    { contentDisposition: 'verified_workspace_reference' }
    | { contentDisposition: 'verified_inline_snapshot'; content: string })>;
  selection?: { kind: 'exact_workspace_references'; selectedFiles: number; omittedFiles: number };
}

export type CodexRepositoryFragments = Record<string, { kind: 'untrusted'; value: string }>;
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const schemaRoot = fileURLToPath(new URL('./', import.meta.url));

export async function parseNamedRepositoryContext(text: string): Promise<NamedRepositoryContext> {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8000 || containsCredential(text)
    || Buffer.from(text).toString('utf8') !== text) throw new Error('codex_session_repository_context_invalid');
  let value: NamedRepositoryContext;
  try { value = JSON.parse(text) as NamedRepositoryContext; }
  catch { throw new Error('codex_session_repository_context_invalid'); }
  if (!(await validateContract(schemaRoot, contextSchema.$id, value)).ok
    || new Set(value.files.map(file => file.path.toLowerCase())).size !== value.files.length) {
    throw new Error('codex_session_repository_context_invalid');
  }
  if (value.files.some(file => file.path.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('codex_session_repository_context_invalid');
  }
  if (value.selection && (value.selection.selectedFiles !== value.files.length
    || value.selection.omittedFiles + value.files.length > 32
    || value.files.some(file => file.contentDisposition !== 'verified_inline_snapshot'))) {
    throw new Error('codex_session_repository_context_invalid');
  }
  for (const file of value.files) if (file.contentDisposition === 'verified_inline_snapshot') {
    if (!value.selection || Buffer.byteLength(file.content) !== file.sizeBytes || digest(file.content) !== file.sha256
      || Buffer.from(file.content).toString('utf8') !== file.content) {
      throw new Error('codex_session_repository_context_invalid');
    }
  }
  return value;
}

export async function fragmentCodexRepositoryContext(text: string): Promise<CodexRepositoryFragments> {
  await parseNamedRepositoryContext(text);
  const contextSha256 = digest(text), chunks: string[] = [];
  const value = (content: string, index: number, total: number) => JSON.stringify({
    schema: 'dharma.codex-repository-context-fragment/v1', contextSha256, index, total, content })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  let chunk = '';
  // Codex160 middle-truncates a value above4000UTF8bytes. Include JSON framing in this stricter bound.
  for (const character of text) {
    if (Buffer.byteLength(value(chunk + character, 7, 8)) > 3500) {
      if (!chunk || chunks.length >= 7) throw new Error('codex_session_repository_context_invalid');
      chunks.push(chunk); chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  if (!chunks.length || chunks.length > 8 || chunks.join('') !== text) throw new Error('codex_session_repository_context_invalid');
  const fragments: CodexRepositoryFragments = {};
  for (const [index, content] of chunks.entries()) {
    const encoded = value(content, index, chunks.length);
    if (Buffer.byteLength(encoded) > 3500
      || !(await validateContract(schemaRoot, fragmentSchema.$id, JSON.parse(encoded))).ok) {
      throw new Error('codex_session_repository_context_invalid');
    }
    fragments[`dharma_repository_${String(index).padStart(2, '0')}`] = { kind: 'untrusted', value: encoded };
  }
  return fragments;
}
