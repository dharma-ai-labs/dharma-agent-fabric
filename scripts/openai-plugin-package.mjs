#!/usr/bin/env node
// Builds and validates the plugin ZIP uploaded to the OpenAI plugin portal
// (one listing for ChatGPT and Codex).
//
//   node scripts/openai-plugin-package.mjs --out <file.zip>
//     [--submission <substituted-copy.json>] [--demo-recording-url <https URL>]
//     [--allow-placeholders]
//
// The ZIP holds, at its root: plugin.json (openai-app/package/plugin.json plus
// the review cases from the submission file), mcp.json, the icon assets and the
// skills. Validation errors go to stderr and exit 1 without writing the ZIP.
// A summary goes to stdout as JSON. `--allow-placeholders` builds a draft from
// the committed submission, whose {{...}} values come from the private seed
// receipt; never upload a draft for review.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const repoRoot = resolve(import.meta.dirname, '..');
const defaultPluginDir = resolve(repoRoot, 'plugins/dharma-agent-fabric');
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g;
const ICON_FIELDS = ['logo', 'composerIcon'];
const MAX_ICON_BYTES = 5 * 1024 * 1024;

function listFiles(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(resolve(dir, entry.name), path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// Maps the reviewer cases from chatgpt-app-submission.json to the plugin
// manifest's review.test_cases shape.
export function reviewCases(submission) {
  const positive = submission.test_cases.map(testCase => ({
    description: testCase.description,
    prompt: testCase.user_prompt,
    tools_triggered: testCase.tools_triggered,
    expected_behavior: testCase.expected_output,
    ...(testCase.file_attachment_urls ? { file_attachment_urls: testCase.file_attachment_urls } : {}),
    ...(testCase.expected_output_url ? { expected_output_url: testCase.expected_output_url } : {}),
  }));
  const negative = submission.negative_test_cases.map(testCase => ({
    description: testCase.description,
    prompt: testCase.user_prompt,
  }));
  return { positive, negative };
}

// Returns the ZIP entries as a Map of ZIP path to bytes.
export function buildPluginPackage({ pluginDir = defaultPluginDir, submission, demoRecordingUrl } = {}) {
  const packageDir = resolve(pluginDir, 'openai-app/package');
  const manifest = JSON.parse(readFileSync(resolve(packageDir, 'plugin.json'), 'utf8'));
  const openai = manifest.extensions['com.openai'];
  openai.review = {
    ...openai.review,
    test_cases: reviewCases(submission),
    ...(demoRecordingUrl ? { demo_recording_url: demoRecordingUrl } : {}),
  };
  const entries = new Map();
  entries.set('plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  entries.set('mcp.json', readFileSync(resolve(packageDir, 'mcp.json')));
  for (const path of listFiles(resolve(pluginDir, 'assets'), 'assets')) entries.set(path, readFileSync(resolve(pluginDir, path)));
  for (const path of listFiles(resolve(pluginDir, 'skills'), 'skills')) entries.set(path, readFileSync(resolve(pluginDir, path)));
  return entries;
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Returns a list of problems; empty means the package meets the rules.
export function validatePluginPackage(entries, { allowPlaceholders = false } = {}) {
  const problems = [];
  for (const name of entries.keys()) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) problems.push(`unsafe ZIP path ${name}`);
    if (/(^|\/)hooks(\/|\.json$)/.test(name)) problems.push(`lifecycle hook file ${name}: plugins with hooks cannot be submitted`);
    if (/(^|\/)\.app\.json$/.test(name)) problems.push(`app reference file ${name}: .app.json cannot be submitted`);
    if (name.startsWith('.codex-plugin/')) problems.push(`${name}: the root plugin.json replaces the Codex overlay; do not ship both`);
  }
  if (!entries.has('plugin.json')) return [...problems, 'plugin.json is missing at the ZIP root'];
  let manifest;
  try {
    manifest = JSON.parse(entries.get('plugin.json').toString('utf8'));
  } catch (error) {
    return [...problems, `plugin.json is not JSON: ${error.message}`];
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(manifest.name))) problems.push('plugin.json name must be kebab-case');
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) problems.push('plugin.json version must be x.y.z');
  if (!manifest.description) problems.push('plugin.json description is missing');
  const openai = manifest.extensions?.['com.openai'];
  if (!openai || typeof openai !== 'object') return [...problems, 'plugin.json extensions["com.openai"] must be an object'];
  for (const [where, object] of [['plugin.json', manifest], ['extensions["com.openai"]', openai]]) {
    if (Object.hasOwn(object, 'hooks')) problems.push(`${where} declares hooks: plugins with hooks cannot be submitted`);
    if (Object.hasOwn(object, 'apps')) problems.push(`${where} declares apps: app references cannot be submitted`);
  }

  const iface = openai.interface ?? {};
  for (const field of ICON_FIELDS) {
    const path = iface[field];
    if (typeof path !== 'string' || !path.startsWith('./')) {
      problems.push(`interface.${field} must be a ./-prefixed path (Codex package validation requires logo and composerIcon)`);
      continue;
    }
    const bytes = entries.get(path.slice(2));
    if (!bytes) {
      problems.push(`interface.${field} ${path} is not in the ZIP`);
      continue;
    }
    const size = pngSize(bytes);
    if (!size) problems.push(`interface.${field} ${path} must be a PNG`);
    else if (size.width !== size.height || size.width < 48 || size.width > 4096) problems.push(`interface.${field} ${path} must be square, 48 to 4096 pixels (is ${size.width}x${size.height})`);
    if (bytes.length > MAX_ICON_BYTES) problems.push(`interface.${field} ${path} is over 5 MiB`);
  }

  const cases = openai.review?.test_cases ?? {};
  const positive = Array.isArray(cases.positive) ? cases.positive : [];
  const negative = Array.isArray(cases.negative) ? cases.negative : [];
  if (positive.length !== 5) problems.push(`review.test_cases needs exactly 5 positive cases (has ${positive.length})`);
  if (negative.length !== 3) problems.push(`review.test_cases needs exactly 3 negative cases (has ${negative.length})`);
  positive.forEach((testCase, index) => {
    for (const key of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) {
      if (typeof testCase[key] !== 'string' || !testCase[key]) problems.push(`positive case ${index + 1} needs a string ${key}`);
    }
  });
  negative.forEach((testCase, index) => {
    for (const key of ['description', 'prompt']) {
      if (typeof testCase[key] !== 'string' || !testCase[key]) problems.push(`negative case ${index + 1} needs a string ${key}`);
    }
  });
  const recording = openai.review?.demo_recording_url;
  if (recording !== undefined && !/^https:\/\/\S+$/.test(String(recording))) problems.push('review.demo_recording_url must be an https URL');

  const text = entries.get('plugin.json').toString('utf8');
  for (const key of ['test_credentials', 'reviewer_instructions']) {
    if (text.includes(`"${key}"`)) problems.push(`plugin.json must not contain ${key}: ZIP metadata rejects it`);
  }
  if (!allowPlaceholders) {
    const left = [...new Set(text.match(PLACEHOLDER) ?? [])];
    if (left.length) problems.push(`unsubstituted placeholders: ${left.join(', ')} (pass --submission <substituted copy>)`);
  }

  if (!entries.has('mcp.json')) {
    problems.push('mcp.json is missing at the ZIP root');
  } else {
    try {
      const servers = Object.entries(JSON.parse(entries.get('mcp.json').toString('utf8')).mcpServers ?? {});
      if (servers.length !== 1) problems.push(`mcp.json must declare exactly one MCP server (has ${servers.length})`);
      for (const [name, server] of servers) {
        if (!server.type) problems.push(`mcp.json server ${name} needs a transport type`);
        if (!/^https:\/\//.test(String(server.url))) problems.push(`mcp.json server ${name} needs a public https URL`);
      }
    } catch (error) {
      problems.push(`mcp.json is not JSON: ${error.message}`);
    }
  }
  if (!entries.has('skills/dharma-agent-fabric/SKILL.md')) problems.push('skills/dharma-agent-fabric/SKILL.md is missing');
  return problems;
}

// Deterministic ZIP: sorted entries, fixed 1980-01-01 timestamps, deflate.
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of [...entries.keys()].sort()) {
    const data = entries.get(name);
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function parseArgs(argv) {
  const options = { allowPlaceholders: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--allow-placeholders') options.allowPlaceholders = true;
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--submission') options.submission = argv[++index];
    else if (arg === '--demo-recording-url') options.demoRecordingUrl = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.out) throw new Error('--out <file.zip> is required');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const submissionPath = options.submission ?? resolve(defaultPluginDir, 'openai-app/chatgpt-app-submission.json');
  const submission = JSON.parse(readFileSync(submissionPath, 'utf8'));
  const entries = buildPluginPackage({ submission, demoRecordingUrl: options.demoRecordingUrl });
  const problems = validatePluginPackage(entries, { allowPlaceholders: options.allowPlaceholders });
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`openai-plugin-package: ${problem}\n`);
    process.exit(1);
  }
  const zip = writeZip(entries);
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(options.out, zip);
  const manifest = JSON.parse(entries.get('plugin.json').toString('utf8'));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    out: options.out,
    name: manifest.name,
    version: manifest.version,
    entries: [...entries.keys()].sort(),
    draft: options.allowPlaceholders,
    demoRecordingUrl: Boolean(options.demoRecordingUrl),
  })}\n`);
}
