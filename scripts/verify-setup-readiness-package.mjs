import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('npm_execpath is required for package verification.');
const manifest = JSON.parse(await readFile(resolve(root, 'packages/local-vault/package.json'), 'utf8'));
const cli = JSON.parse(await readFile(resolve(root, 'packages/cli/package.json'), 'utf8'));
if (cli.dependencies[manifest.name] !== manifest.version
  || manifest.exports?.['./setup-readiness'] !== './dist/setupReadiness.js') throw new Error('setup_readiness_package_pin_invalid');
const parent = await realpath(tmpdir()), temporary = await mkdtemp(resolve(parent, 'dharma-readiness-pack-'));
try {
  const {stdout} = await execute(process.execPath, [npm, 'pack', '--workspace', 'packages/local-vault',
    '--ignore-scripts', '--pack-destination', temporary, '--json'], {cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024});
  const packed = JSON.parse(stdout);
  if (packed.length !== 1 || packed[0].name !== manifest.name || packed[0].version !== manifest.version
    || dirname(packed[0].filename) !== '.' || !/^[A-Za-z0-9._-]+\.tgz$/.test(packed[0].filename)) {
    throw new Error('setup_readiness_package_identity_invalid');
  }
  const paths = new Set(packed[0].files.map(file => file.path));
  for (const path of ['package.json', 'dist/setupReadiness.js', 'dist/setupReadiness.d.ts']) {
    if (!paths.has(path)) throw new Error('setup_readiness_package_export_missing');
  }
  const target = resolve(temporary, 'node_modules', '@dharma-ai-labs', 'agent-fabric-local-vault');
  await mkdir(target, {recursive: true});
  const tarball = await readFile(resolve(temporary, packed[0].filename));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (integrity !== packed[0].integrity) throw new Error('setup_readiness_package_integrity_invalid');
  // Extract only reviewed public files needed for the pure subpath consumer.
  await execute('tar', ['-xf', resolve(temporary, packed[0].filename), '-C', target, '--strip-components', '1',
    'package/package.json', 'package/dist/setupReadiness.js', 'package/dist/setupReadiness.d.ts'],
  {cwd: temporary, timeout: 30_000, maxBuffer: 1024 * 1024});
  const consumer = `import assert from 'node:assert/strict';
    import {parseLocalCodexSetupReadiness} from '@dharma-ai-labs/agent-fabric-local-vault/setup-readiness';
    assert.equal(typeof parseLocalCodexSetupReadiness, 'function');
    assert.throws(() => parseLocalCodexSetupReadiness({}), {message: 'setup_readiness_invalid'});
    process.stdout.write('pure-readiness-export-ok');`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', consumer],
    {cwd: temporary, timeout: 30_000, maxBuffer: 1024 * 1024});
  if (result.stdout !== 'pure-readiness-export-ok' || result.stderr !== '') throw new Error('setup_readiness_package_import_unclean');
  process.stdout.write(`${JSON.stringify({ok: true, package: manifest.name, version: manifest.version,
    integrity, tarballSha256: createHash('sha256').update(tarball).digest('hex'),
    isolatedConsumer: true, monorepoLink: false, stderrClean: true, published: false})}\n`);
} finally {
  if (dirname(temporary) !== parent || !temporary.startsWith(resolve(parent, 'dharma-readiness-pack-'))) {
    throw new Error('setup_readiness_cleanup_target_invalid');
  }
  await rm(temporary, {recursive: true, force: true});
}
