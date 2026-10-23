import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { captureBaseline, generatePluginSkills, verifyPluginSkills, selectEventBaseline, readGitBaseline } from './plugin-skill-parity.mjs';

const repository = resolve(import.meta.dirname, '..');
const canonical = 'plugins/dharma-agent-fabric/skills/dharma-agent-fabric';
const generated = 'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric';
const files = ['SKILL.md', ...['a2a', 'byok-billing', 'control-agent',
  'evaluation-remediation', 'installation', 'security-authority', 'skill-releases',
  'task-orchestration', 'trajectory-sync'].map(name => `references/${name}.md`)];
const normalized = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');

test('repository baseline: every generated operational skill file matches the authored source', () => {
  for (const file of files) {
    const target = resolve(repository, generated, file);
    assert.ok(existsSync(target), `missing generated ${file}`);
    assert.equal(normalized(readFileSync(target)), normalized(readFileSync(resolve(repository, canonical, file))));
  }
});

test('repository baseline: normal package validation includes the parity and version guard', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(repository, 'package.json')));
  assert.equal(scripts['plugin:skills:check'], 'node --test scripts/plugin-skill-parity.test.mjs && node scripts/plugin-skill-parity.mjs');
  assert.ok(scripts.check.includes('npm run plugin:skills:check'));
});

test('repository baseline: LF policy enumerates only the accepted common source and destination files', () => {
  const path = resolve(repository, '.gitattributes');
  const attributes = existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/) : [];
  assert.deepEqual(attributes, [canonical, generated].flatMap(root => files.map(file => `${root}/${file} text eol=lf`)));
});

function fixture(run) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'dharma-plugin-parity-'));
  assert.ok(root.startsWith(parent + sep));
  const put = (path, value) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), value);
  };
  const skill = `---\nname: dharma-agent-fabric\ndescription: Operate authorized Fabric workflows.\n---\n${files.slice(1).map(path => `[Reference](${path})`).join('\n')}\n`;
  for (const dir of [canonical, generated]) for (const file of files) put(`${dir}/${file}`, file === 'SKILL.md' ? skill : '# Reference\n');
  const manifests = {
    codex: 'plugins/dharma-agent-fabric/.codex-plugin/plugin.json',
    claude: 'plugins/claude/dharma-agent-fabric/.claude-plugin/plugin.json',
  };
  put(manifests.codex, JSON.stringify({ version: '0.1.0' }));
  put(manifests.claude, JSON.stringify({ version: '1.0.4' }));
  put('plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md',
    '---\nname: dharma-agent-fabric-setup\ndescription: Enroll or recover an authorized client.\n---\n');
  put('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'dharma-agent-fabric', version: '1.0.4' }] }));
  const bump = (route, version) => {
    put(manifests[route], JSON.stringify({ version }));
    if (route === 'claude') put('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'dharma-agent-fabric', version }] }));
  };
  try { return run({ root, put, bump, baseline: captureBaseline(root), skill }); }
  finally {
    assert.equal(realpathSync(root), root);
    assert.ok(root.startsWith(parent + sep));
    rmSync(root, { recursive: true, force: true });
  }
}

test('unchanged enumerated trees pass with independent unchanged versions', () => fixture(({ root, baseline }) => {
  const result = verifyPluginSkills(root, baseline);
  assert.equal(result.fileCount, 10);
  assert.equal(result.rawByteParity, true);
  assert.deepEqual(result.routes.map(route => [route.name, route.version, route.contentChanged]),
    [['codex', '0.1.0', false], ['claude', '1.0.4', false]]);
}));

test('generation fills missing files, is deterministic and leaves setup and canonical bytes unchanged', () => fixture(({ root, baseline }) => {
  const source = readFileSync(resolve(root, canonical, 'SKILL.md'));
  const setup = readFileSync(resolve(root, 'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md'));
  rmSync(resolve(root, generated, 'SKILL.md'));
  assert.equal(generatePluginSkills(root).writtenFiles, 1);
  assert.equal(generatePluginSkills(root).writtenFiles, 0);
  assert.deepEqual(readFileSync(resolve(root, canonical, 'SKILL.md')), source);
  assert.deepEqual(readFileSync(resolve(root, 'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md')), setup);
  assert.equal(verifyPluginSkills(root, baseline).rawByteParity, true);
}));

test('first generation creates only the ten accepted common files and preserves route version independence', () => fixture(({ root, baseline, bump }) => {
  rmSync(resolve(root, generated), { recursive: true });
  baseline.claude.files = {};
  assert.equal(generatePluginSkills(root).writtenFiles, 10);
  bump('claude', '1.0.5');
  assert.deepEqual(verifyPluginSkills(root, baseline).routes.map(route => route.version), ['0.1.0', '1.0.5']);
}));

test('CRLF normalization is scoped text parity, not raw equality or a content-version change', () => fixture(({ root, put, baseline, skill }) => {
  put(`${canonical}/SKILL.md`, skill.replace(/\n/g, '\r\n'));
  const report = verifyPluginSkills(root, baseline);
  assert.equal(report.rawByteParity, false);
  assert.ok(report.routes.every(route => !route.contentChanged));
}));

for (const side of [canonical, generated]) {
  test(`missing accepted file rejects ${side}`, () => fixture(({ root, baseline }) => {
    rmSync(resolve(root, side, files[1]));
    assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_file_set_invalid/);
  }));
  test(`extra file rejects without cleanup ${side}`, () => fixture(({ root, put, baseline }) => {
    put(`${side}/unexpected.md`, 'PRIVATE_CANARY');
    assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_file_set_invalid$/);
    assert.throws(() => generatePluginSkills(root), /^Error: plugin_skill_file_set_invalid$/);
    assert.equal(readFileSync(resolve(root, side, 'unexpected.md'), 'utf8'), 'PRIVATE_CANARY');
  }));
}

test('changed generated content rejects until regenerated, independently of a version bump', () => fixture(({ root, put, baseline, bump }) => {
  put(`${generated}/references/a2a.md`, '# Drift\n');
  bump('claude', '1.0.5');
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_parity_mismatch/);
  assert.equal(generatePluginSkills(root).writtenFiles, 1);
  assert.equal(verifyPluginSkills(root, baseline).routes[1].version, '1.0.5');
}));

for (const target of ['references/missing.md', 'references/A2A.md', '../../outside.md', 'file:///private', 'javascript:bad']) {
  test(`unsupported or broken local link rejects ${target}`, () => fixture(({ root, put, baseline, skill }) => {
    for (const side of [canonical, generated]) put(`${side}/SKILL.md`, `${skill}[Bad](${target})\n`);
    assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_reference_invalid$/);
  }));
}

for (const invalid of [Buffer.from([0xff]), Buffer.from('# Bare\rCR\n'), Buffer.from('# Null\0\n')]) {
  test(`invalid common text rejects ${invalid.toString('hex')}`, () => fixture(({ root, put, baseline }) => {
    put(`${canonical}/references/a2a.md`, invalid);
    assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_text_invalid$/);
  }));
}

test('a symlink directory is rejected before reading or writing outside the fixture', () => fixture(({ root, baseline }) => {
  const outside = resolve(root, 'outside');
  mkdirSync(outside);
  writeFileSync(resolve(outside, 'private.md'), 'PRIVATE_CANARY');
  rmSync(resolve(root, generated, 'references'), { recursive: true });
  symlinkSync(outside, resolve(root, generated, 'references'), 'junction');
  assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_path_invalid$/);
  assert.throws(() => generatePluginSkills(root), /^Error: plugin_skill_path_invalid$/);
  assert.equal(readFileSync(resolve(outside, 'private.md'), 'utf8'), 'PRIVATE_CANARY');
}));

test('duplicate setup metadata is rejected without modifying the setup skill', () => fixture(({ root, put, baseline, skill }) => {
  put('plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md', skill);
  assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_metadata_invalid$/);
}));

test('a duplicate description also rejects when the two skill names remain distinct', () => fixture(({ root, put, baseline }) => {
  put('plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/SKILL.md',
    '---\nname: dharma-agent-fabric-setup\ndescription: Operate authorized Fabric workflows.\n---\n');
  assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_metadata_invalid$/);
}));

for (const link of ['[Bad]()', '[Bad](references/space name.md)', '[Bad](references/%61%32%61.md)', '[Bad](references/a2a.md']) {
  test(`malformed or unsupported inline syntax rejects ${link}`, () => fixture(({ root, put, baseline, skill }) => {
    for (const side of [canonical, generated]) put(`${side}/SKILL.md`, `${skill}${link}\n`);
    assert.throws(() => verifyPluginSkills(root, baseline), /^Error: plugin_skill_reference_invalid$/);
  }));
}

test('oversized common files fail before generation writes a destination', () => fixture(({ root, put, baseline }) => {
  const before = readFileSync(resolve(root, generated, files[1]));
  put(`${canonical}/${files[1]}`, Buffer.alloc(65_537, 65));
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_path_invalid/);
  assert.throws(() => generatePluginSkills(root), /plugin_skill_path_invalid/);
  assert.deepEqual(readFileSync(resolve(root, generated, files[1])), before);
}));

test('a common content change requires independent strictly greater versions on both affected routes', () => fixture(({ root, put, bump, baseline }) => {
  for (const side of [canonical, generated]) put(`${side}/references/a2a.md`, '# Changed\n');
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_increment_required/);
  bump('claude', '1.0.5');
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_increment_required/);
  bump('codex', '0.1.1');
  assert.ok(verifyPluginSkills(root, baseline).routes.every(route => route.contentChanged));
}));

test('adding the operational skill only to Claude requires no Codex version synchronization', () => fixture(({ root, baseline, bump }) => {
  baseline.claude.files = {};
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_increment_required/);
  bump('claude', '1.0.5');
  const report = verifyPluginSkills(root, baseline);
  assert.deepEqual(report.routes.map(route => [route.version, route.contentChanged]), [['0.1.0', false], ['1.0.5', true]]);
}));

test('content-set removal, downgrades and invalid versions do not pass', () => fixture(({ root, baseline, bump }) => {
  baseline.codex.files['old.md'] = '# Previously shipped\n';
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_increment_required/);
  bump('codex', '0.0.9');
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_increment_required/);
  bump('codex', '0.01.1');
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_version_invalid/);
}));

test('marketplace and plugin candidate versions must agree', () => fixture(({ root, put, baseline }) => {
  put('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'dharma-agent-fabric', version: '1.0.5' }] }));
  assert.throws(() => verifyPluginSkills(root, baseline), /plugin_skill_marketplace_version_mismatch/);
}));

test('CI accepts only supported concrete baseline metadata; a new push branch explicitly requests merge-base', () => {
  const sha = 'a'.repeat(40);
  assert.equal(selectEventBaseline('pull_request', { pull_request: { base: { sha } } }), sha);
  assert.equal(selectEventBaseline('push', { before: sha }), sha);
  assert.equal(selectEventBaseline('push', { before: '0'.repeat(40) }), null);
  for (const [event, data] of [['pull_request', {}], ['push', { before: '--arbitrary' }], ['workflow_dispatch', {}]]) {
    assert.throws(() => selectEventBaseline(event, data), /^Error: plugin_skill_baseline_invalid$/);
  }
});

test('an arbitrary Git baseline argument is rejected before Git can be invoked', () => {
  for (const invalid of ['HEAD', '--output=PRIVATE_CANARY', 'a'.repeat(39), 'A'.repeat(40)]) {
    assert.throws(() => readGitBaseline(repository, invalid), /^Error: plugin_skill_baseline_invalid$/);
  }
});
