import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const commonFiles = Object.freeze(['SKILL.md', ...['a2a', 'byok-billing', 'control-agent',
  'evaluation-remediation', 'installation', 'security-authority', 'skill-releases',
  'task-orchestration', 'trajectory-sync'].map(name => `references/${name}.md`)]);
const routes = [
  { name: 'codex', common: 'plugins/dharma-agent-fabric/skills/dharma-agent-fabric', manifest: 'plugins/dharma-agent-fabric/.codex-plugin/plugin.json' },
  { name: 'claude', common: 'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric', manifest: 'plugins/claude/dharma-agent-fabric/.claude-plugin/plugin.json' },
];
const setupPath = 'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md';
const marketplacePath = '.claude-plugin/marketplace.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`plugin_skill_${code}`); };
const commitPattern = /^[a-f0-9]{40}$/;

function safePath(root, relative, missing = false) {
  let current = resolve(root);
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) fail('path_invalid');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) fail('path_invalid');
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail('path_invalid');
  }
  return current;
}

function text(bytes) {
  try {
    if (bytes.length > 65_536) fail('text_invalid');
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n');
    if (value.includes('\r') || value.includes('\0')) fail('text_invalid');
    return value;
  } catch { return fail('text_invalid'); }
}

function read(root, relative) {
  const path = safePath(root, relative);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65_536) fail('path_invalid');
  return readFileSync(path);
}

function tree(root, common, partial = false) {
  const directory = safePath(root, common, partial);
  if (!directory) return {};
  const paths = [];
  const walk = (base, prefix = '') => {
    if (!lstatSync(base).isDirectory()) fail('path_invalid');
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) fail('path_invalid');
      if (entry.isDirectory() && relative === 'references') walk(resolve(base, entry.name), 'references/');
      else if (entry.isFile()) paths.push(relative);
      else fail('file_set_invalid');
      if (paths.length > commonFiles.length) fail('file_set_invalid');
    }
  };
  walk(directory);
  if (paths.some(path => !commonFiles.includes(path)) || (!partial && paths.length !== commonFiles.length)) fail('file_set_invalid');
  return Object.fromEntries(paths.sort().map(path => [path, read(root, `${common}/${path}`)]));
}

function normalized(files) { return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, text(bytes)])); }
function contentHash(files) { return digest(JSON.stringify(Object.keys(files).sort().map(path => [path, digest(files[path])]))); }
function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail('version_invalid');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) fail('version_invalid');
  return parts;
}
function greater(left, right) {
  const a = version(left), b = version(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
function json(bytes) { try { return JSON.parse(text(bytes)); } catch { return fail('metadata_invalid'); } }

function metadata(value) {
  try {
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(value);
    const parsed = match && parse(match[1]);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || !parsed.description.trim()) fail('metadata_invalid');
    return parsed;
  } catch { return fail('metadata_invalid'); }
}

function checkReferences(files) {
  for (const [path, body] of Object.entries(files)) {
    // This closed Markdown tree uses inline links, not reference-style definitions.
    if (/^\s*\[[^\]]+\]:/m.test(body)) fail('reference_invalid');
    const links = [...body.matchAll(/\]\(([^)]*)\)/g)];
    if (links.length !== (body.match(/\]\(/g)?.length ?? 0)) fail('reference_invalid');
    for (const match of links) {
      const parsed = /^([^\s)]+)(?:\s+"[^"]*")?$/.exec(match[1]);
      if (!parsed) fail('reference_invalid');
      const target = parsed[1];
      if (/^(https?:\/\/|mailto:|#)/.test(target)) continue;
      if (/[:%?\\]/.test(target) || target.startsWith('/')) fail('reference_invalid');
      const relative = posix.normalize(posix.join(posix.dirname(path), target.split('#')[0]));
      if (!Object.hasOwn(files, relative)) fail('reference_invalid');
    }
  }
}

export function captureBaseline(root) {
  return Object.fromEntries(routes.map(route => [route.name, {
    version: json(read(root, route.manifest)).version,
    files: normalized(tree(root, route.common, true)),
  }]));
}

export function verifyPluginSkills(root, baseline) {
  const raw = routes.map(route => tree(root, route.common));
  const contents = raw.map(normalized);
  for (const files of contents) checkReferences(files);
  if (contentHash(contents[0]) !== contentHash(contents[1])) fail('parity_mismatch');
  const operational = metadata(contents[0]['SKILL.md']);
  const setup = metadata(text(read(root, setupPath)));
  if (operational.name !== 'dharma-agent-fabric' || setup.name !== 'dharma-agent-fabric-setup'
    || operational.description.trim() === setup.description.trim()) fail('metadata_invalid');
  const reports = routes.map((route, index) => {
    const currentVersion = json(read(root, route.manifest)).version;
    version(currentVersion);
    const previous = baseline?.[route.name];
    if (!previous || !previous.files) fail('baseline_invalid');
    version(previous.version);
    const contentChanged = contentHash(contents[index]) !== contentHash(previous.files);
    if (currentVersion !== previous.version && !greater(currentVersion, previous.version)) fail('version_increment_required');
    if (contentChanged && !greater(currentVersion, previous.version)) fail('version_increment_required');
    return { name: route.name, version: currentVersion, contentChanged, normalizedSha256: contentHash(contents[index]) };
  });
  const entries = json(read(root, marketplacePath)).plugins;
  if (!Array.isArray(entries) || entries.filter(item => item.name === 'dharma-agent-fabric').length !== 1
    || entries.find(item => item.name === 'dharma-agent-fabric').version !== reports[1].version) fail('marketplace_version_mismatch');
  return { ok: true, fileCount: commonFiles.length, rawByteParity: commonFiles.every(path => raw[0][path].equals(raw[1][path])), routes: reports };
}

export function generatePluginSkills(root, { dryRun = false } = {}) {
  if (typeof dryRun !== 'boolean') fail('arguments_invalid');
  const source = normalized(tree(root, routes[0].common));
  checkReferences(source);
  const target = tree(root, routes[1].common, true);
  const plan = commonFiles.filter(path => !target[path]?.equals(Buffer.from(source[path], 'utf8')));
  const writes = plan.map(path => ({ path: `${routes[1].common}/${path}`,
    beforeSha256: target[path] ? digest(target[path]) : null, afterSha256: digest(source[path]) }));
  for (const path of dryRun ? [] : plan) {
    const relative = `${routes[1].common}/${path}`;
    const parent = dirname(resolve(root, relative));
    safePath(root, relative, true);
    mkdirSync(parent, { recursive: true });
    safePath(root, relative, true);
    writeFileSync(resolve(root, relative), source[path], { flag: target[path] ? 'w' : 'wx' });
  }
  return { ok: true, dryRun, plannedFiles: plan.length, writtenFiles: dryRun ? 0 : plan.length,
    writes, normalizedSha256: contentHash(source) };
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 262_144, timeout: 15_000, windowsHide: true });
  if (result.error || result.status !== 0) fail('git_baseline_unavailable');
  return result.stdout;
}

export function readGitBaseline(root, sha) {
  if (!commitPattern.test(sha)) fail('baseline_invalid');
  return Object.fromEntries(routes.map(route => {
    const listing = git(root, ['ls-tree', '-rz', sha, '--', route.common]).toString('utf8').split('\0').filter(Boolean);
    if (listing.length > 64) fail('baseline_invalid');
    const files = {};
    for (const entry of listing) {
      const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
      if (!match || !match[2].startsWith(route.common + '/')) fail('baseline_invalid');
      files[match[2].slice(route.common.length + 1)] = text(git(root, ['show', `${sha}:${match[2]}`]));
    }
    const manifest = json(git(root, ['show', `${sha}:${route.manifest}`]));
    return [route.name, { version: manifest.version, files }];
  }));
}

export function selectEventBaseline(eventName, event, dispatchedSha) {
  const sha = eventName === 'pull_request' ? event?.pull_request?.base?.sha
    : eventName === 'push' ? event?.before : eventName === 'workflow_dispatch' ? dispatchedSha : undefined;
  if (typeof sha !== 'string' || !commitPattern.test(sha)) fail('baseline_invalid');
  if (/^0+$/.test(sha)) { if (eventName === 'push') return null; fail('baseline_invalid'); }
  return sha;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  if (args.includes('--write') || args.includes('--dry-run')) {
    if (new Set(args).size !== args.length || args.some(arg => !['--write', '--dry-run'].includes(arg))) fail('arguments_invalid');
    return generatePluginSkills(root, { dryRun: args.includes('--dry-run') });
  }
  let base;
  if (args.length === 2 && args[0] === '--base' && commitPattern.test(args[1])) base = args[1];
  else if (args.length) fail('arguments_invalid');
  else if (process.env.GITHUB_ACTIONS === 'true') {
    if (!process.env.GITHUB_EVENT_PATH) fail('baseline_invalid');
    let event;
    try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { fail('baseline_invalid'); }
    base = selectEventBaseline(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA);
    // Manual publication validates the selected immutable checkout, not an invented previous release.
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && base !== git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()) fail('baseline_invalid');
    if (!base) base = git(root, ['merge-base', 'HEAD', 'origin/main']).toString('utf8').trim();
  } else base = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  return { ...verifyPluginSkills(root, readGitBaseline(root, base)), baselineCommit: base };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.stdout.write(JSON.stringify(main()) + '\n'); }
  catch (error) {
    const code = /^plugin_skill_[a-z_]+$/.test(error?.message) ? error.message : 'plugin_skill_check_failed';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
