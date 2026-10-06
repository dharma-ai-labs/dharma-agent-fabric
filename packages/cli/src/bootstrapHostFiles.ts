import {lstat, mkdir, open, rename} from 'node:fs/promises';
import {constants, type BigIntStats} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname, isAbsolute, resolve} from 'node:path';
import {types} from 'node:util';
import type {BootstrapHostScope} from './bootstrapHostScope.js';

function captureJson(value: unknown): string {
  let count = 0;
  const seen = new Set<object>();
  const invalid = (): never => {throw new Error('codex_setup_host_state_invalid');};
  const copy = (item: unknown, depth: number): unknown => {
    if (++count > 50_000 || depth > 20) return invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return item.length <= 2 * 1024 * 1024 ? item : invalid();
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item) || seen.has(item)) return invalid();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const fields = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string'
      || !Object.hasOwn(fields[key]!, 'value') || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key))) return invalid();
    seen.add(item);
    try {
      if (array) {
        if (item.length > 50_000 || Object.keys(fields).length !== item.length + 1) return invalid();
        return Array.from({length: item.length}, (_, index) => {
          const field = fields[String(index)];
          if (!field?.enumerable) return invalid();
          return copy(field.value, depth + 1);
        });
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(fields)) {
        if (!field.enumerable || key.length > 4096) return invalid();
        // Preserve JSON's omission of optional undefined object properties.
        if (field.value === undefined) continue;
        result[key] = copy(field.value, depth + 1);
      }
      return result;
    } finally {seen.delete(item);}
  };
  // Copy before any asynchronous admission, without invoking caller accessors.
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) return invalid();
  const bytes = `${JSON.stringify(copy(value, 0), null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) return invalid();
  return bytes;
}

/** Lifetime fence, not a replacement for the caller's approved path policy. */
export async function writeBootstrapHostJson(path: string, value: unknown, scope: BootstrapHostScope) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('codex_setup_host_state_path_invalid');
  const bytes = Buffer.from(captureJson(value));
  await scope.assert();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await scope.step(() => mkdir(dirname(path), {recursive: true, mode: 0o700}));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: BigIntStats | undefined;
  const matches = (a: BigIntStats, b: BigIntStats) => a.isFile() && a.nlink === 1n
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.birthtimeNs === b.birthtimeNs
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const verifyOwned = async () => {
    if (!identity) throw new Error('codex_setup_host_state_ownership_unconfirmed');
    let reader: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await scope.step(async () => {reader = await open(temporary, constants.O_RDONLY
        | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));});
      const before = await scope.step(() => reader!.stat({bigint: true}));
      if (!matches(before, identity) || before.size !== BigInt(bytes.length)) throw new Error('codex_setup_host_state_ownership_unconfirmed');
      const retained = Buffer.alloc(bytes.length + 1); let count = 0;
      while (count < retained.length) {
        const result = await scope.step(() => reader!.read(retained, count, retained.length - count, count));
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      const after = await scope.step(() => reader!.stat({bigint: true}));
      const current = await scope.step(() => lstat(temporary, {bigint: true}));
      if (count !== bytes.length || !retained.subarray(0, count).equals(bytes)
        || !matches(after, before) || !matches(current, after)) throw new Error('codex_setup_host_state_ownership_unconfirmed');
    } finally {
      try {await reader?.close();} catch {throw new Error('codex_setup_host_state_cleanup_unconfirmed');}
    }
  };
  try {
    await scope.step(async () => {handle = await open(temporary, constants.O_CREAT | constants.O_EXCL
      | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);});
    await scope.step(() => handle!.writeFile(bytes));
    await scope.step(() => handle!.sync());
    identity = await scope.step(() => handle!.stat({bigint: true}));
    try {await handle!.close();} catch {throw new Error('codex_setup_host_state_cleanup_unconfirmed');}
    handle = undefined;
    await verifyOwned();
    await scope.step(() => rename(temporary, path));
  } finally {
    try {await handle?.close();} catch {throw new Error('codex_setup_host_state_cleanup_unconfirmed');}
    // Preserve failed staging as recovery evidence. No automatic path-based
    // deletion can establish atomic ownership against a concurrent replacement.
    // Explicit recovery must separately qualify cleanup; never undo publication.
  }
}
