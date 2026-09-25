import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

type DocumentName = 'MANIFEST.json' | 'CATALOG.json';
export interface TaskKnowledgeScope {
  directory: string;
  manifestSha256: string;
  catalogSha256: string;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_BYTES = 262_144;
const PAGE_CHARACTERS = 8_192;
const MAXIMUM_RESPONSE_CHARACTERS = 32_768;

export function validateTaskKnowledgeScope(scope: TaskKnowledgeScope): void {
  if (!isAbsolute(scope.directory) || !SHA256.test(scope.manifestSha256)
    || !SHA256.test(scope.catalogSha256)) throw new Error('Invalid task knowledge scope.');
}

export async function readVerifiedTaskDocument(scope: TaskKnowledgeScope, name: DocumentName): Promise<string> {
  validateTaskKnowledgeScope(scope);
  const path = resolve(scope.directory, name);
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1
    || initial.size < 1 || initial.size > MAXIMUM_BYTES) throw new Error('Task knowledge file is invalid.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev
      || opened.size !== initial.size) throw new Error('Task knowledge file changed.');
    const bytes = await handle.readFile();
    const expected = name === 'MANIFEST.json' ? scope.manifestSha256 : scope.catalogSha256;
    if (bytes.length !== initial.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected) {
      throw new Error('Task knowledge hash mismatch.');
    }
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('Task knowledge encoding is invalid.');
    return value;
  } finally { await handle.close(); }
}

function response(value: unknown) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAXIMUM_RESPONSE_CHARACTERS) {
    return { content: [{ type: 'text' as const,
      text: 'Task knowledge result exceeds the tool limit. Narrow the query or use read_document pages.' }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: serialized }] };
}

function failure(error: unknown) {
  return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
}

export function createTaskKnowledgeServer(scope: TaskKnowledgeScope): McpServer {
  validateTaskKnowledgeScope(scope);
  const server = new McpServer({ name: 'dharma-task-knowledge', version: '1.0.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool('read_document', {
    description: 'Read a bounded page of the receipt-pinned repository manifest or knowledge catalog.',
    inputSchema: z.object({ document: z.enum(['manifest', 'catalog']),
      offset: z.number().int().min(0).max(MAXIMUM_BYTES).default(0),
      limit: z.number().int().min(1).max(PAGE_CHARACTERS).default(PAGE_CHARACTERS) }),
    annotations,
  }, async ({ document, offset, limit }) => {
    try {
      const name = document === 'manifest' ? 'MANIFEST.json' : 'CATALOG.json';
      const contents = await readVerifiedTaskDocument(scope, name);
      return response({ document, sha256: document === 'manifest' ? scope.manifestSha256 : scope.catalogSha256,
        offset, nextOffset: Math.min(contents.length, offset + limit), totalCharacters: contents.length,
        text: contents.slice(offset, offset + limit) });
    } catch (error) { return failure(error); }
  });

  server.registerTool('catalog_search', {
    description: 'Find canonical concepts by name, alias, or definition in the receipt-pinned catalog.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(128),
      offset: z.number().int().min(0).max(10_000).default(0),
      limit: z.number().int().min(1).max(10).default(10) }),
    annotations,
  }, async ({ query, offset, limit }) => {
    try {
      const catalog = JSON.parse(await readVerifiedTaskDocument(scope, 'CATALOG.json')) as {
        concepts?: Array<{ conceptId?: string; canonicalName?: string; aliases?: string[]; definition?: string }>;
      };
      if (!Array.isArray(catalog.concepts)) throw new Error('Task knowledge catalog is invalid.');
      const term = query.toLocaleLowerCase('en-US');
      const matches = catalog.concepts.filter(concept => [concept.conceptId, concept.canonicalName,
        concept.definition, ...(concept.aliases || [])].some(value => typeof value === 'string'
          && value.toLocaleLowerCase('en-US').includes(term)));
      return response({ catalogSha256: scope.catalogSha256, total: matches.length, offset,
        concepts: matches.slice(offset, offset + limit).map(({ conceptId, canonicalName, aliases, definition }) => ({
          conceptId, canonicalName, aliases, definition,
        })) });
    } catch (error) { return failure(error); }
  });

  server.registerTool('catalog_concept', {
    description: 'Read one canonical concept with its source references and unresolved conflicts.',
    inputSchema: z.object({ conceptId: z.string().regex(/^concept_[a-z0-9][a-z0-9_-]{0,79}$/) }),
    annotations,
  }, async ({ conceptId }) => {
    try {
      const catalog = JSON.parse(await readVerifiedTaskDocument(scope, 'CATALOG.json')) as {
        concepts?: Array<{ conceptId?: string }>;
        unresolved?: Array<{ conceptId?: string }>;
      };
      if (!Array.isArray(catalog.concepts)) throw new Error('Task knowledge catalog is invalid.');
      const concept = catalog.concepts.find(item => item.conceptId === conceptId);
      if (!concept) return response({ catalogSha256: scope.catalogSha256, found: false, conceptId });
      return response({ catalogSha256: scope.catalogSha256, found: true, concept,
        unresolved: (catalog.unresolved || []).filter(item => item.conceptId === conceptId) });
    } catch (error) { return failure(error); }
  });
  return server;
}

async function main(): Promise<void> {
  const [directory, manifestSha256, catalogSha256] = process.argv.slice(2);
  const scope = { directory, manifestSha256, catalogSha256 } as TaskKnowledgeScope;
  validateTaskKnowledgeScope(scope);
  await Promise.all([
    readVerifiedTaskDocument(scope, 'MANIFEST.json'),
    readVerifiedTaskDocument(scope, 'CATALOG.json'),
  ]);
  await serveStdio(() => createTaskKnowledgeServer(scope));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(`Task knowledge server failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
