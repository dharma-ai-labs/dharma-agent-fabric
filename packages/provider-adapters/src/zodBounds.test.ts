import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as z from 'zod/v4';

test('patched Zod floor covers the direct declaration and every locked copy', () => {
  const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(root.overrides?.zod, '4.6.6');
  assert.equal(own.dependencies.zod, '4.6.6');
  const copies = Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/zod$/.test(path));
  assert.ok(copies.length > 0);
  for (const [, entry] of copies) {
    const pinned = entry as { version: string; resolved: string; integrity: string };
    assert.equal(pinned.version, '4.6.6');
    assert.equal(pinned.resolved, 'https://registry.npmjs.org/zod/-/zod-4.6.6.tgz');
    assert.equal(pinned.integrity, 'sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==');
  }
});

test('patched Zod rejects an oversized bounded array before parsing elements', () => {
  let visited = 0;
  const element = z.preprocess(value => { visited++; return value; }, z.string());
  const schema = z.array(element).max(2);
  const oversized = schema.safeParse([1, 2, 3]);
  assert.equal(oversized.success, false);
  assert.equal(visited, 0);
  assert.deepEqual(oversized.error!.issues.map(issue => issue.code), ['too_big']);
  assert.equal(schema.safeParse(['one']).success, true);
  assert.equal(visited, 1);
  assert.equal(schema.safeParse([1]).success, false);
  assert.equal(visited, 2);
});

test('patched Zod rejects an oversized bounded set before parsing elements', () => {
  let visited = 0;
  const element = z.preprocess(value => { visited++; return value; }, z.string());
  const schema = z.set(element).size(2);
  const oversized = schema.safeParse(new Set([1, 2, 3]));
  assert.equal(oversized.success, false);
  assert.equal(visited, 0);
  assert.deepEqual(oversized.error!.issues.map(issue => issue.code), ['too_big']);
  assert.equal(schema.safeParse(new Set(['one', 'two'])).success, true);
  assert.equal(visited, 2);
  assert.equal(schema.safeParse(new Set([1, 2])).success, false);
  assert.equal(visited, 4);
});

test('patched Zod rejects an oversized bounded map before parsing keys or values', () => {
  let visited = 0;
  const element = z.preprocess(value => { visited++; return value; }, z.string());
  const schema = z.map(element, element).max(2);
  const oversized = schema.safeParse(new Map([[1, 1], [2, 2], [3, 3]]));
  assert.equal(oversized.success, false);
  assert.equal(visited, 0);
  assert.deepEqual(oversized.error!.issues.map(issue => issue.code), ['too_big']);
  assert.equal(schema.safeParse(new Map([['one', 'two']])).success, true);
  assert.equal(visited, 2);
  assert.equal(schema.safeParse(new Map([[1, 1]])).success, false);
  assert.equal(visited, 4);
});
