// Offline checks for the OpenAI plugin ZIP that is uploaded to the plugin
// portal (one listing for ChatGPT and Codex). The rules come from OpenAI's
// plugin submission docs: a root `plugin.json` with settings under
// `extensions["com.openai"]`, a root `mcp.json`, `logo` and `composerIcon`
// (Codex package validation requires both), exactly five positive and three
// negative review cases for the initial MCP app review, and no lifecycle hooks
// or app references (`apps` / `.app.json`). No network or credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const pluginDir = resolve(root, 'plugins/dharma-agent-fabric');
const appDir = resolve(pluginDir, 'openai-app');
const script = resolve(root, 'scripts/openai-plugin-package.mjs');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const submission = readJson(resolve(appDir, 'chatgpt-app-submission.json'));
const codexManifest = readJson(resolve(pluginDir, '.codex-plugin/plugin.json'));
const codexMcp = readJson(resolve(pluginDir, '.mcp.json'));
const loadPackager = () => import(script);

// Reads a ZIP independently of the packager, so the packager does not check
// its own output.
function readZip(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  assert.ok(eocd >= 0, 'end of central directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central directory header');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header for ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function pngSize(bytes) {
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function build(args) {
  const dir = mkdtempSync(join(tmpdir(), 'openai-plugin-package-'));
  const out = join(dir, 'package.zip');
  const result = spawnSync(process.execPath, [script, '--out', out, ...args], { encoding: 'utf8' });
  const zip = existsSync(out) ? readFileSync(out) : null;
  rmSync(dir, { recursive: true, force: true });
  return { ...result, zip };
}

test('the submission has exactly five positive and three negative review cases', () => {
  assert.equal(submission.test_cases.length, 5, 'initial MCP app review requires exactly five positive cases');
  assert.equal(submission.negative_test_cases.length, 3, 'initial MCP app review requires exactly three negative cases');
});

test('logo and composerIcon are square PNG assets inside the plugin, declared in the Codex manifest', () => {
  for (const field of ['logo', 'composerIcon']) {
    const path = codexManifest.interface[field];
    assert.match(String(path), /^\.\/assets\/[a-z0-9-]+\.png$/, `${field} is a ./assets/ PNG path`);
    const file = resolve(pluginDir, path);
    assert.ok(existsSync(file), `${field} file ${path} exists`);
    const bytes = readFileSync(file);
    assert.ok(bytes.length <= 5 * 1024 * 1024, `${field} is at most 5 MiB`);
    const { width, height } = pngSize(bytes);
    assert.equal(width, height, `${field} is square`);
    assert.ok(width >= 48 && width <= 4096, `${field} is 48 to 4096 pixels`);
  }
});

test('the built ZIP has a root plugin.json and mcp.json, the assets and the skills, and nothing else', () => {
  const result = build(['--allow-placeholders']);
  assert.equal(result.status, 0, result.stderr);
  const entries = readZip(result.zip);
  const names = [...entries.keys()].sort();
  assert.ok(names.includes('plugin.json'), 'plugin.json at the ZIP root');
  assert.ok(names.includes('mcp.json'), 'mcp.json at the ZIP root');
  for (const name of names) {
    assert.ok(/^(plugin\.json|mcp\.json|assets\/[a-z0-9-]+\.png|skills\/dharma-agent-fabric\/(SKILL\.md|references\/[a-z0-9-]+\.md))$/.test(name), `unexpected ZIP entry ${name}`);
  }
  assert.ok(names.includes('skills/dharma-agent-fabric/SKILL.md'));
  assert.equal(names.some(name => /(^|\/)hooks(\/|\.json$)|\.app\.json$|^\.codex-plugin\/|^\.mcp\.json$|^openai-app\//.test(name)), false, 'no hooks, app references, Codex overlay or internal review files');

  const manifest = JSON.parse(entries.get('plugin.json').toString('utf8'));
  assert.equal(manifest.name, 'dharma-agent-fabric');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const openai = manifest.extensions?.['com.openai'];
  assert.equal(typeof openai, 'object', 'settings live under extensions["com.openai"]');
  assert.equal(Object.hasOwn(manifest, 'hooks') || Object.hasOwn(openai, 'hooks'), false, 'no lifecycle hooks');
  assert.equal(Object.hasOwn(manifest, 'apps') || Object.hasOwn(openai, 'apps'), false, 'no app references');
  for (const field of ['logo', 'composerIcon']) {
    const path = openai.interface[field];
    assert.match(String(path), /^\.\//, `${field} is ./-prefixed`);
    const bytes = entries.get(path.slice(2));
    assert.ok(bytes, `${field} ${path} is in the ZIP`);
    const { width, height } = pngSize(bytes);
    assert.equal(width, height);
  }
  for (const field of ['displayName', 'shortDescription', 'developerName', 'category', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    assert.equal(openai.interface[field], codexManifest.interface[field], `interface.${field} matches the Codex manifest`);
  }

  const review = openai.review.test_cases;
  assert.equal(review.positive.length, 5);
  assert.equal(review.negative.length, 3);
  review.positive.forEach((testCase, index) => {
    const source = submission.test_cases[index];
    assert.equal(testCase.description, source.description);
    assert.equal(testCase.prompt, source.user_prompt);
    assert.equal(testCase.tools_triggered, source.tools_triggered);
    assert.equal(typeof testCase.tools_triggered, 'string');
    assert.equal(testCase.expected_behavior, source.expected_output);
  });
  review.negative.forEach((testCase, index) => {
    assert.deepEqual(testCase, { description: submission.negative_test_cases[index].description, prompt: submission.negative_test_cases[index].user_prompt });
  });
  const text = entries.get('plugin.json').toString('utf8');
  assert.doesNotMatch(text, /test_credentials|reviewer_instructions/, 'ZIP metadata rejects credentials and reviewer instructions');

  const mcp = JSON.parse(entries.get('mcp.json').toString('utf8'));
  const servers = Object.entries(mcp.mcpServers);
  assert.equal(servers.length, 1, 'only one MCP server can be connected per plugin');
  const [[serverName, server]] = servers;
  assert.equal(server.url, codexMcp.mcpServers[serverName].url, 'same endpoint as the Codex .mcp.json');
  assert.match(server.url, /^https:\/\//);
  assert.equal(server.type, 'streamable-http', 'the portable format declares a transport type');
});

test('the build is byte-for-byte reproducible', () => {
  const first = build(['--allow-placeholders']);
  const second = build(['--allow-placeholders']);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.zip.equals(second.zip));
});

test('the build refuses unsubstituted placeholders unless told the ZIP is a draft', () => {
  const result = build([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\{\{REVIEWER_ORG_ID\}\}/);
  assert.equal(result.zip, null, 'no ZIP is written when validation fails');
});

test('a filled submission copy and a demo recording URL go into the review metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openai-plugin-filled-'));
  try {
    const filledPath = join(dir, 'filled.json');
    writeFileSync(filledPath, JSON.stringify(submission).replace(/\{\{[A-Z0-9_]+\}\}/g, 'fixture-value'));
    const result = build(['--submission', filledPath, '--demo-recording-url', 'https://example.com/walkthrough']);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readZip(result.zip).get('plugin.json').toString('utf8'));
    assert.equal(manifest.extensions['com.openai'].review.demo_recording_url, 'https://example.com/walkthrough');
    assert.doesNotMatch(JSON.stringify(manifest), /\{\{/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the validator rejects hooks, app references, missing icons and wrong case counts', async () => {
  const { buildPluginPackage, validatePluginPackage } = await loadPackager();
  const good = buildPluginPackage({ pluginDir, submission });
  assert.deepEqual(validatePluginPackage(good, { allowPlaceholders: true }), []);

  const withEntry = (name, bytes) => new Map([...good, [name, Buffer.from(bytes)]]);
  const withManifest = edit => {
    const manifest = JSON.parse(good.get('plugin.json').toString('utf8'));
    edit(manifest);
    return new Map([...good, ['plugin.json', Buffer.from(JSON.stringify(manifest))]]);
  };
  const problems = entries => validatePluginPackage(entries, { allowPlaceholders: true }).join('\n');

  assert.match(problems(withEntry('hooks/hooks.json', '{}')), /hook/);
  assert.match(problems(withManifest(manifest => { manifest.extensions['com.openai'].hooks = './hooks/hooks.json'; })), /hook/);
  assert.match(problems(withEntry('.app.json', '{}')), /\.app\.json/);
  assert.match(problems(withManifest(manifest => { manifest.extensions['com.openai'].apps = './.app.json'; })), /apps/);
  assert.match(problems(withManifest(manifest => { delete manifest.extensions['com.openai'].interface.composerIcon; })), /composerIcon/);
  assert.match(problems(withManifest(manifest => { delete manifest.extensions['com.openai'].interface.logo; })), /logo/);
  const withoutLogoFile = new Map(good);
  withoutLogoFile.delete('assets/logo.png');
  assert.match(problems(withoutLogoFile), /logo/);
  assert.match(problems(withManifest(manifest => { manifest.extensions['com.openai'].review.test_cases.positive.push({ description: 'x', prompt: 'x', tools_triggered: 'x', expected_behavior: 'x' }); })), /exactly 5 positive/);
  assert.match(problems(withManifest(manifest => { manifest.extensions['com.openai'].review.test_cases.negative.pop(); })), /exactly 3 negative/);
  assert.match(problems(withManifest(manifest => { manifest.extensions['com.openai'].review.test_credentials = {}; })), /test_credentials/);
  const withoutRootManifest = new Map(good);
  withoutRootManifest.delete('plugin.json');
  assert.match(problems(withoutRootManifest), /plugin\.json/);
});
