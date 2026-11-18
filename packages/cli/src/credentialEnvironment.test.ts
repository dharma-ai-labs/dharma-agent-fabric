import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { run } from './index.js';

// Synthetic values only. No test reads a real relay environment, Dharma home,
// vault, credential store or token.
const CREDENTIAL_NAMES = ['DHARMA_ORG_API_TOKEN', 'DHARMA_VAULT_KEY', 'DHARMA_ALLOW_ENV_KEY'] as const;
const SYNTHETIC_TOKEN = 'synthetic-organization-token';
const SYNTHETIC_KEY = Buffer.alloc(32, 7).toString('base64');

interface CredentialEnvironmentModule {
  captureCredentialEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void;
  credentialVariable(name: string, source?: NodeJS.ProcessEnv): string | undefined;
  relayChildEnvironment(source?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Record<string, string>;
  resetCredentialEnvironment(): void;
}

async function credentials(): Promise<CredentialEnvironmentModule> {
  const specifier = './credentialEnvironment.js';
  return await import(specifier) as CredentialEnvironmentModule;
}

function withoutCredentials(source: NodeJS.ProcessEnv): Record<string, string> {
  const names = new Set<string>(CREDENTIAL_NAMES);
  return Object.fromEntries(Object.entries(source)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !names.has(entry[0].toUpperCase())));
}

test('capture moves credential variables into memory and keeps every other name', async () => {
  const module = await credentials();
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CODEX_HOME: '/synthetic/codex', SYNTHETIC_TOOL_TOKEN: 'tool',
    DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN, DHARMA_VAULT_KEY: SYNTHETIC_KEY, DHARMA_ALLOW_ENV_KEY: '1' };
  try {
    module.captureCredentialEnvironment(env, 'linux');
    assert.deepEqual(env, { PATH: '/usr/bin', CODEX_HOME: '/synthetic/codex', SYNTHETIC_TOOL_TOKEN: 'tool' });
    assert.equal(module.credentialVariable('DHARMA_ORG_API_TOKEN', env), SYNTHETIC_TOKEN);
    assert.equal(module.credentialVariable('DHARMA_VAULT_KEY', env), SYNTHETIC_KEY);
    assert.equal(module.credentialVariable('DHARMA_ALLOW_ENV_KEY', env), '1');
  } finally { module.resetCredentialEnvironment(); }
});

test('capture on Windows removes every letter-case spelling of a credential variable', async () => {
  const module = await credentials();
  const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows', dharma_org_api_token: SYNTHETIC_TOKEN,
    Dharma_Vault_Key: SYNTHETIC_KEY, DHARMA_ALLOW_ENV_KEY: '1' };
  try {
    module.captureCredentialEnvironment(env, 'win32');
    assert.deepEqual(env, { Path: 'C:\\Windows' });
    assert.equal(module.credentialVariable('DHARMA_ORG_API_TOKEN', env), SYNTHETIC_TOKEN);
    assert.equal(module.credentialVariable('DHARMA_VAULT_KEY', env), SYNTHETIC_KEY);
  } finally { module.resetCredentialEnvironment(); }
});

test('capture keeps the first captured value and a live environment value still wins', async () => {
  const module = await credentials();
  try {
    module.captureCredentialEnvironment({ DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN }, 'linux');
    module.captureCredentialEnvironment({ DHARMA_ORG_API_TOKEN: 'synthetic-later-token' }, 'linux');
    assert.equal(module.credentialVariable('DHARMA_ORG_API_TOKEN', {}), SYNTHETIC_TOKEN);
    assert.equal(module.credentialVariable('DHARMA_ORG_API_TOKEN', { DHARMA_ORG_API_TOKEN: 'synthetic-live-token' }),
      'synthetic-live-token');
  } finally { module.resetCredentialEnvironment(); }
});

test('relay children get the explicit vault key pair but never the organization token', async () => {
  const module = await credentials();
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CODEX_HOME: '/synthetic/codex', SYNTHETIC_TOOL_TOKEN: 'tool',
    DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN, DHARMA_VAULT_KEY: SYNTHETIC_KEY, DHARMA_ALLOW_ENV_KEY: '1' };
  try {
    module.captureCredentialEnvironment(env, 'linux');
    assert.deepEqual(module.relayChildEnvironment(env, 'linux'), { PATH: '/usr/bin', CODEX_HOME: '/synthetic/codex',
      SYNTHETIC_TOOL_TOKEN: 'tool', DHARMA_ALLOW_ENV_KEY: '1', DHARMA_VAULT_KEY: SYNTHETIC_KEY });
    // A token that is still in the source (for example set after start-up) is not passed either.
    assert.equal(Object.hasOwn(module.relayChildEnvironment({ ...env, DHARMA_ORG_API_TOKEN: 'synthetic-live-token' }, 'linux'),
      'DHARMA_ORG_API_TOKEN'), false);
  } finally { module.resetCredentialEnvironment(); }
});

test('relay children get no vault key unless the explicit key path is switched on', async () => {
  const module = await credentials();
  try {
    module.captureCredentialEnvironment({ DHARMA_VAULT_KEY: SYNTHETIC_KEY }, 'linux');
    assert.deepEqual(module.relayChildEnvironment({ PATH: '/usr/bin' }, 'linux'), { PATH: '/usr/bin' });
    module.resetCredentialEnvironment();
    module.captureCredentialEnvironment({ DHARMA_ALLOW_ENV_KEY: '1' }, 'linux');
    assert.deepEqual(module.relayChildEnvironment({ PATH: '/usr/bin' }, 'linux'), { PATH: '/usr/bin' });
  } finally { module.resetCredentialEnvironment(); }
});

test('users who set no credential variables see an unchanged environment', async () => {
  const module = await credentials();
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/synthetic', SYNTHETIC_TOOL_TOKEN: 'tool' };
  try {
    module.captureCredentialEnvironment(env, 'linux');
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/synthetic', SYNTHETIC_TOOL_TOKEN: 'tool' });
    assert.deepEqual(module.relayChildEnvironment(env, 'linux'), env);
    for (const name of CREDENTIAL_NAMES) assert.equal(module.credentialVariable(name, env), undefined);
  } finally { module.resetCredentialEnvironment(); }
});

// Starts a real CLI process with a preload that reports, when the process exits,
// which credential names it started with, which are still in process.env, which a
// child spawned with the default (inherited) environment sees, and which values
// the CLI still holds in memory.
async function reportCliProcess(entry: 'index.js' | 'bin.js', env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'dharma-credential-environment-'));
  try {
    const report = join(root, 'report.json');
    const preload = join(root, 'preload.mjs');
    const moduleUrl = new URL('./credentialEnvironment.js', import.meta.url).href;
    await writeFile(preload, `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as credentials from ${JSON.stringify(moduleUrl)};
const names = ${JSON.stringify(CREDENTIAL_NAMES)};
const present = () => names.filter(name => process.env[name] !== undefined);
const initial = present();
process.on('exit', () => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
    { encoding: 'utf8' });
  const childNames = JSON.parse(child.stdout || '[]').filter(name => names.includes(name.toUpperCase()));
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ initial, remaining: present(), child: childNames,
    memory: Object.fromEntries(names.map(name => [name, credentials.credentialVariable(name) ?? null])) }));
});
`);
    const cli = fileURLToPath(new URL(`./${entry}`, import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'version'],
        { env: { ...env, DHARMA_HOME: join(root, 'home') }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => accept({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(await readFile(report, 'utf8')) as {
      initial: string[]; remaining: string[]; child: string[]; memory: Record<string, string | null>;
    };
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const entry of ['index.js', 'bin.js'] as const) {
  test(`the CLI started through ${entry} keeps credential variables in memory and out of its children`, async () => {
    const report = await reportCliProcess(entry, { ...withoutCredentials(process.env),
      DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN, DHARMA_VAULT_KEY: SYNTHETIC_KEY, DHARMA_ALLOW_ENV_KEY: '1' });
    assert.deepEqual(report.initial, [...CREDENTIAL_NAMES]);
    assert.deepEqual(report.remaining, [], 'process.env no longer holds credential variables after start-up');
    assert.deepEqual(report.child, [], 'a child with the inherited environment sees no credential variable');
    assert.deepEqual(report.memory, { DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN, DHARMA_VAULT_KEY: SYNTHETIC_KEY,
      DHARMA_ALLOW_ENV_KEY: '1' });
  });
}

test('a relay child started with the relay child environment gets only the vault key pair and removes it on start', async () => {
  const module = await credentials();
  try {
    module.captureCredentialEnvironment({ DHARMA_ORG_API_TOKEN: SYNTHETIC_TOKEN, DHARMA_VAULT_KEY: SYNTHETIC_KEY,
      DHARMA_ALLOW_ENV_KEY: '1' }, process.platform);
    const childEnvironment = module.relayChildEnvironment(withoutCredentials(process.env), process.platform);
    assert.equal(Object.hasOwn(childEnvironment, 'DHARMA_ORG_API_TOKEN'), false);
    const report = await reportCliProcess('index.js', childEnvironment);
    assert.deepEqual(report.initial, ['DHARMA_VAULT_KEY', 'DHARMA_ALLOW_ENV_KEY']);
    assert.deepEqual(report.remaining, []);
    assert.deepEqual(report.child, []);
    assert.deepEqual(report.memory, { DHARMA_ORG_API_TOKEN: null, DHARMA_VAULT_KEY: SYNTHETIC_KEY, DHARMA_ALLOW_ENV_KEY: '1' });
  } finally { module.resetCredentialEnvironment(); }
});

test('the CLI started without credential variables sees no change', async () => {
  const report = await reportCliProcess('index.js', withoutCredentials(process.env));
  assert.deepEqual(report, { initial: [], remaining: [], child: [],
    memory: { DHARMA_ORG_API_TOKEN: null, DHARMA_VAULT_KEY: null, DHARMA_ALLOW_ENV_KEY: null } });
});

test('organization commands still use a token captured from the environment', async () => {
  const module = await credentials();
  const root = await mkdtemp(join(tmpdir(), 'dharma-credential-org-'));
  const previous = { home: process.env.DHARMA_HOME, token: process.env.DHARMA_ORG_API_TOKEN };
  const originalFetch = globalThis.fetch;
  const authorizations: Array<string | null> = [];
  process.env.DHARMA_HOME = join(root, 'home');
  process.env.DHARMA_ORG_API_TOKEN = SYNTHETIC_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Request(input, init).headers.get('authorization'));
    return new Response(JSON.stringify({ ok: true, agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    module.captureCredentialEnvironment();
    assert.equal(process.env.DHARMA_ORG_API_TOKEN, undefined);
    const listed = await run(['agents', 'list', '--organization-id', 'org_synthetic',
      '--hq-url', 'https://hq.example.com']) as Record<string, unknown>;
    assert.equal(listed.ok, true);
    assert.deepEqual(authorizations, [`Bearer ${SYNTHETIC_TOKEN}`]);
  } finally {
    globalThis.fetch = originalFetch;
    module.resetCredentialEnvironment();
    if (previous.home === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous.home;
    if (previous.token === undefined) delete process.env.DHARMA_ORG_API_TOKEN; else process.env.DHARMA_ORG_API_TOKEN = previous.token;
    await rm(root, { recursive: true, force: true });
  }
});

// Each relay process that the CLI starts gets an environment built for that spawn.
function spawnEnvironments(file: string, source: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Array<{ argv: string; env: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'spawn' && node.arguments.length >= 3
      && node.arguments[0]!.getText(ast) === 'process.execPath') {
      const argv = node.arguments[1]!.getText(ast);
      if (/'relay', 'supervise'|'relay', 'start'|'sessions', 'serve'|\bargs\b/.test(argv)) {
        const options = node.arguments[2]!;
        const env = ts.isObjectLiteralExpression(options) ? options.properties.find(property =>
          ts.isPropertyAssignment(property) && property.name.getText(ast) === 'env') : undefined;
        found.push({ argv, env: env && ts.isPropertyAssignment(env) ? env.initializer.getText(ast) : '' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

test('supervisor, relay start, sessions serve and container relay children get the relay child environment', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const container = await readFile(new URL('../src/containerRelayLifecycle.ts', import.meta.url), 'utf8');
  const indexSpawns = spawnEnvironments('index.ts', index);
  assert.deepEqual(indexSpawns.map(item => item.env), ['relayChildEnvironment()', 'relayChildEnvironment()',
    'relayChildEnvironment()']);
  assert.deepEqual(spawnEnvironments('containerRelayLifecycle.ts', container).map(item => item.env),
    ['{ ...relayChildEnvironment(), DHARMA_HOME: options.home }']);
});

test('CLI sources read credential variables only through the captured credential environment', async () => {
  const { readdir } = await import('node:fs/promises');
  const directory = new URL('../src/', import.meta.url);
  const offenders: string[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'credentialEnvironment.ts') continue;
    const source = await readFile(new URL(name, directory), 'utf8');
    if (/process\.env\.(DHARMA_ORG_API_TOKEN|DHARMA_VAULT_KEY|DHARMA_ALLOW_ENV_KEY)\b/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
  assert.ok((await readdir(directory)).includes('credentialEnvironment.ts'));
});
