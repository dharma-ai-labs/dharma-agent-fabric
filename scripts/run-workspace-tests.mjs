import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaces = [];
for (const parent of ['apps', 'packages']) {
  for (const name of (await readdir(resolve(parent), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const packagePath = resolve(parent, name, 'package.json');
    let manifest;
    try { manifest = JSON.parse(await readFile(packagePath, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (typeof manifest.name === 'string' && typeof manifest.scripts?.test === 'string') {
      workspaces.push({ name: manifest.name, directory: resolve(parent, name), test: manifest.scripts.test });
    }
  }
}

for (const workspace of workspaces) {
  const result = spawnSync(workspace.test, {
    cwd: workspace.directory,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`${JSON.stringify({ ok: true, testedWorkspaces: workspaces.length })}\n`);
