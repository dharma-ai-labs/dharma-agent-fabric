import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Preview is a label only, and it must appear wherever a preview route is
// advertised. Grok, Agy (Antigravity), Hermes Agent and Gemini client routes
// are previews; Codex and Claude Code are GA.
const repository = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(repository, path), 'utf8').replace(/\r\n/g, '\n');
const previewRoute = /\b(Grok|Agy|Antigravity|Hermes|Gemini CLI|Gemini Web)\b/;
const labelled = text => /\bpreview\b/i.test(text);

const markdownSurfaces = [
  'README.md',
  'docs/onboarding/customer-guide.md',
  'packages/cli/README.md',
  'packages/provider-adapters/README.md',
  'plugins/claude/dharma-agent-fabric/README.md',
];

test('every heading and table row that advertises a preview route carries the preview label', () => {
  const missing = [];
  for (const path of markdownSurfaces) {
    read(path).split('\n').forEach((line, index) => {
      if (!/^\s*(#|\|)/.test(line) || /^\s*\|\s*-/.test(line)) return;
      if (previewRoute.test(line) && !labelled(line)) missing.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(missing, []);
});

test('provider lists in the customer guide and package READMEs label Agy and Hermes as preview', () => {
  const lists = [
    ['docs/onboarding/customer-guide.md', /^- repository-local instructions and policy for .*$/m],
    ['docs/onboarding/customer-guide.md', /^7\. detects .*$/m],
    ['packages/cli/README.md', /Current provider adapters are[\s\S]*?\. Run/],
    ['packages/provider-adapters/README.md', /Capability-scoped local adapters for[\s\S]*?\. Each adapter/],
  ];
  for (const [path, pattern] of lists) {
    const match = read(path).match(pattern);
    assert.ok(match, `${path}: provider list not found`);
    assert.match(match[0], /Agy \(preview/, `${path}: Agy lacks the preview label`);
    assert.match(match[0], /Hermes Agent\s+\(preview/, `${path}: Hermes lacks the preview label`);
  }
});

test('Grok install prose and plugin manifests carry the preview label', () => {
  const readme = read('README.md');
  assert.match(readme, /Grok support is a preview, not GA\. The same plugin/);
  assert.match(readme, /grok\.com \(preview, not GA\) can connect through a custom connector/);
  assert.match(read('plugins/claude/dharma-agent-fabric/README.md'), /\(Claude Code, Grok \(preview\) or another MCP-capable client\)/);
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  const manifest = JSON.parse(read('plugins/claude/dharma-agent-fabric/.claude-plugin/plugin.json'));
  for (const description of [marketplace.metadata.description, ...marketplace.plugins.map(item => item.description), manifest.description]) {
    if (/Grok/.test(description)) assert.match(description, /Grok \(preview/, description);
  }
});

test('host table matches the Agy and Hermes adapters', () => {
  const rows = read('README.md').split('\n');
  const agy = rows.find(line => line.startsWith('| Agy'));
  const hermes = rows.find(line => line.startsWith('| Hermes'));
  // agyCapability: activation is unavailable below Agy 1.1.15 and every task passes --new-project.
  assert.match(agy, /unavailable below 1\.1\.15/);
  assert.match(agy, /--new-project/);
  assert.doesNotMatch(agy, /plugin enable \+ next session/);
  // hermesCapability: task execution follows the version alone; there is no pre-dispatch provider check.
  assert.doesNotMatch(hermes, /when its model provider is configured/);
  assert.match(hermes, /missing inference provider shows as a task failure after the run/);
  const adapters = read('packages/provider-adapters/README.md');
  assert.doesNotMatch(adapters, /only after Hermes reports a configured\s+inference provider/);
  assert.match(adapters, /does not\s+check for a configured inference provider before dispatch/);
});
