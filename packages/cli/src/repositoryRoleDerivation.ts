import type { ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import type { RepositoryPackageSnapshot } from './repositoryPackage.js';

const CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
const TOKEN_CATEGORIES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:audit|review|verify|verifier|test|testing)\b/i, 'verification'],
  [/\b(?:auth|security|permission|policy)\b/i, 'security-review'],
  [/\b(?:api|backend|server|service)\b/i, 'backend-maintenance'],
  [/\b(?:database|db|postgres|sql|supabase)\b/i, 'data-maintenance'],
  [/\b(?:deploy|deployment|release|rollout)\b/i, 'release-management'],
  [/\b(?:doc|docs|documentation|readme)\b/i, 'documentation'],
  [/\b(?:frontend|react|ui|ux|web)\b/i, 'frontend-maintenance'],
];

function sourceNames(snapshot: RepositoryPackageSnapshot) {
  const blobs = new Map(snapshot.blobs.map(blob => [blob.sha256, blob.contentBase64]));
  const names: string[] = [];
  for (const skill of snapshot.manifest.skills) {
    if (skill.path.endsWith('/dharma-agent-fabric') || skill.path === 'dharma-agent-fabric') continue;
    names.push(skill.path.split('/').at(-1) || skill.path);
    const entry = snapshot.manifest.files.find(file => file.path === skill.entryPath);
    const encoded = entry ? blobs.get(entry.sha256) : undefined;
    if (!encoded) continue;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 262_144 || bytes.toString('base64') !== encoded) continue;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) continue;
    const header = /^---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    const name = header?.split(/\r?\n/).map(line => /^name:\s*([a-z0-9][a-z0-9._ -]{0,79})\s*$/i.exec(line)?.[1])
      .find((value): value is string => Boolean(value));
    if (name) names.push(name);
  }
  return names;
}

export function deriveRepositoryRole(input: {
  snapshot: RepositoryPackageSnapshot;
  providers: readonly ProviderId[];
}) {
  const providers = [...new Set(input.providers)].sort();
  if (providers.length === 0) throw new Error('Repository role derivation requires a local provider.');
  const names = sourceNames(input.snapshot);
  const searchable = names.join(' ');
  const categories = new Set<string>(['documentation', 'repository-maintenance']);
  for (const [pattern, category] of TOKEN_CATEGORIES) if (pattern.test(searchable)) categories.add(category);
  for (const provider of providers) categories.add(`${provider}-implementation`);
  const questionCategories = [...categories].filter(category => CATEGORY.test(category)).sort().slice(0, 16);
  const label = providers.length === 1
    ? `${providers[0]![0]!.toUpperCase()}${providers[0]!.slice(1)} Repository Maintainer`
    : 'Repository Maintainer';
  const inventory = names.length ? ` using ${Math.min(names.length, 256)} captured repository skill identities` : '';
  return {
    roleName: label,
    questionCategories,
    description: `Maintains this canonical repository${inventory}; routes bounded questions through signed Agent Fabric tasks.`,
  };
}
