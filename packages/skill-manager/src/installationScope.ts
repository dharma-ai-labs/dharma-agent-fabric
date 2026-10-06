import {AsyncLocalStorage} from 'node:async_hooks';
import {KeyObject} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {types} from 'node:util';

/** Supplied by the owning setup host, never by a bundle, task or saved approval. */
export interface SkillInstallationHostScope {
  signal: AbortSignal;
  current(): Promise<boolean>;
}
class InstallationAdmission {
  readonly signal: AbortSignal;
  readonly #closed = new AbortController();
  readonly #current: () => Promise<boolean>;
  constructor(readonly owner: SkillInstallationHostScope) {
    if (!owner || typeof owner !== 'object' || types.isProxy(owner)) throw new Error('skill_installation_scope_unavailable');
    const signal = Object.getOwnPropertyDescriptor(owner, 'signal'), current = Object.getOwnPropertyDescriptor(owner, 'current');
    if (!signal || !Object.hasOwn(signal, 'value') || !(signal.value instanceof AbortSignal)
      || !current || !Object.hasOwn(current, 'value') || typeof current.value !== 'function') {
      throw new Error('skill_installation_scope_unavailable');
    }
    this.signal = AbortSignal.any([signal.value, this.#closed.signal]);
    this.#current = () => Reflect.apply(current.value, owner, []);
  }
  close() {this.#closed.abort();}
  async assert() {
    let permitted = false;
    try {permitted = !this.signal.aborted && await this.#current() === true && !this.signal.aborted;} catch {}
    if (!permitted) {this.close(); throw new Error('skill_installation_scope_unavailable');}
  }
}
const context = new AsyncLocalStorage<InstallationAdmission>();
export function installationScoped() {return context.getStore() !== undefined;}
export async function assertInstallationCurrent() {await context.getStore()?.assert();}
export async function withInstallationAdmission<T>(scope: SkillInstallationHostScope | undefined, operation: () => Promise<T>): Promise<T> {
  const inherited = context.getStore();
  if (inherited) {
    if (scope && inherited.owner !== scope) throw new Error('skill_installation_scope_conflict');
    await inherited.assert(); const result = await operation(); await inherited.assert(); return result;
  }
  if (!scope) return operation();
  const admission = new InstallationAdmission(scope);
  try {return await context.run(admission, async () => {
    await admission.assert(); const result = await operation(); await admission.assert(); return result;
  });} finally {admission.close();}
}

function code(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : undefined;
}
async function effect<T>(operation: () => Promise<T>): Promise<T> {
  const admission = context.getStore(); if (!admission) return operation();
  await admission.assert();
  try {const result = await operation(); await admission.assert(); return result;}
  catch (error) {
    await admission.assert();
    const nativeCode = code(error);
    const failure = new Error('skill_installation_storage_unavailable');
    if (nativeCode && ['ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY'].includes(nativeCode)) {
      Object.assign(failure, {code: nativeCode});
    }
    throw failure;
  }
}

function copyData(value: unknown, budget = {nodes: 100_000, bytes: 64 * 1024 * 1024}, depth = 0, seen = new Set<object>()): unknown {
  const invalid = (): never => {throw new Error('skill_installation_input_invalid');};
  if (--budget.nodes < 0 || depth > 24) return invalid();
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'string') {budget.bytes -= Buffer.byteLength(value); if (budget.bytes < 0) return invalid(); return value;}
  if (typeof value === 'number') {if (!Number.isFinite(value)) return invalid(); return value;}
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) return invalid();
  if (types.isDate(value)) return new Date(Date.prototype.getTime.call(value));
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return invalid();
  const array = Array.isArray(value), result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  if (array && (value.length > 100_000 || Object.keys(fields).length !== value.length + 1)) return invalid();
  seen.add(value);
  for (const [name, field] of Object.entries(fields)) {
    if (array && name === 'length') continue;
    if (name.length > 256 || array && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length)) return invalid();
    Object.defineProperty(result, name, {value: copyData(field.value, budget, depth + 1, seen), enumerable: true});
  }
  seen.delete(value); return Object.freeze(result);
}
export function captureInstallationInput<T extends object>(input: T): {input: T; scope?: SkillInstallationHostScope} {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new Error('skill_installation_input_invalid');
  const scopeField = Object.getOwnPropertyDescriptor(input, 'hostScope');
  if (scopeField && !Object.hasOwn(scopeField, 'value')) throw new Error('skill_installation_input_invalid');
  const scope = scopeField?.value as SkillInstallationHostScope | undefined;
  if (scope !== undefined && (!scope || typeof scope !== 'object' || types.isProxy(scope))) {
    throw new Error('skill_installation_scope_unavailable');
  }
  if (scope === undefined && !installationScoped()) return {input};
  const fields = Object.getOwnPropertyDescriptors(input), captured: Record<string, unknown> = Object.create(null);
  if (Object.getOwnPropertySymbols(input).length || Object.keys(fields).length > 32) throw new Error('skill_installation_input_invalid');
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.hasOwn(field, 'value')) throw new Error('skill_installation_input_invalid');
    if (name === 'hostScope') continue;
    const value = field.value;
    if (['serverPublicKey', 'devicePublicKey', 'devicePrivateKey'].includes(name)) {
      if (value && typeof value === 'object' && types.isProxy(value) || !(value instanceof KeyObject)) throw new Error('skill_installation_input_invalid');
      captured[name] = value;
    } else if (name === 'providerActivationCheck') {
      if (value !== undefined && (typeof value !== 'function' || types.isProxy(value))) throw new Error('skill_installation_input_invalid');
      captured[name] = value === undefined ? undefined : async () => {
        await assertInstallationCurrent();
        let result: unknown;
        try {result = await value();} catch {await assertInstallationCurrent(); throw new Error('skill_installation_activation_unavailable');}
        await assertInstallationCurrent(); return copyData(result);
      };
    } else captured[name] = copyData(value);
  }
  return {input: Object.freeze(captured) as T, scope};
}

type AsyncOperation = (...args: any[]) => Promise<any>;
function guarded<T extends AsyncOperation>(operation: T): T {
  return ((...args: Parameters<T>) => effect(() => operation(...args))) as T;
}
export const lstat = guarded(fs.lstat), readdir = guarded(fs.readdir), readFile = guarded(fs.readFile);
export const rename = guarded(fs.rename), writeFile = guarded(fs.writeFile);

export const mkdir: typeof fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
  if (!installationScoped()) return fs.mkdir(...args);
  const [path, options] = args;
  if (typeof path !== 'string') throw new Error('skill_installation_input_invalid');
  if (!options || typeof options !== 'object' || !options.recursive) return effect(() => fs.mkdir(...args));
  const target = resolve(path);
  const create = async (directory: string): Promise<string | undefined> => {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('skill_installation_directory_invalid');
      return undefined;
    } catch (error) {if (code(error) !== 'ENOENT') throw error;}
    const parent = dirname(directory);
    if (parent === directory) throw new Error('skill_installation_directory_invalid');
    const first = await create(parent);
    try {await effect(() => fs.mkdir(directory, {mode: options.mode}));}
    catch (error) {if (code(error) !== 'EEXIST') throw error;}
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('skill_installation_directory_invalid');
    return first ?? directory;
  };
  return create(target);
}) as typeof fs.mkdir;

export const cp: typeof fs.cp = (async (source, target, options) => {
  if (!installationScoped()) return fs.cp(source, target, options);
  if (typeof source !== 'string' || typeof target !== 'string') throw new Error('skill_installation_input_invalid');
  const visit = async (from: string, to: string, depth = 0): Promise<void> => {
    if (depth > 64) throw new Error('skill_installation_copy_limit');
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) throw new Error('Skill bundles cannot contain symbolic links.');
    if (metadata.isDirectory()) {
      await mkdir(to, {recursive: true, mode: metadata.mode & 0o777});
      for (const name of (await readdir(from)).sort()) await visit(resolve(from, name), resolve(to, name), depth + 1);
    } else {
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('skill_installation_copy_invalid');
      await effect(() => fs.cp(from, to, {...options, recursive: false}));
    }
  };
  await visit(source, target);
}) as typeof fs.cp;

export const rm: typeof fs.rm = (async (path, options) => {
  if (!installationScoped()) return fs.rm(path, options);
  if (typeof path !== 'string') throw new Error('skill_installation_input_invalid');
  const visit = async (target: string, depth = 0): Promise<void> => {
    if (depth > 64) throw new Error('skill_installation_cleanup_limit');
    let metadata;
    try {metadata = await lstat(target);} catch (error) {if (options?.force && code(error) === 'ENOENT') return; throw error;}
    if (metadata.isDirectory() && !metadata.isSymbolicLink() && options?.recursive) {
      for (const name of await readdir(target)) await visit(resolve(target, name), depth + 1);
      await effect(() => fs.rmdir(target));
    } else await effect(() => fs.rm(target, {...options, recursive: false}));
  };
  await visit(path);
}) as typeof fs.rm;

export const open: typeof fs.open = (async (...args: Parameters<typeof fs.open>) => {
  if (!installationScoped()) return fs.open(...args);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {await effect(async () => {handle = await fs.open(...args);});}
  catch (error) {
    try {await handle?.close();} catch {throw new Error('skill_installation_cleanup_unconfirmed');}
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {try {await handle!.close();} catch {throw new Error('skill_installation_cleanup_unconfirmed');}})();
  const owned = handle!;
  return {stat: (...values: Parameters<typeof owned.stat>) => effect(() => owned.stat(...values)),
    read: (...values: Parameters<typeof owned.read>) => effect(() => owned.read(...values)), close} as typeof owned;
}) as typeof fs.open;

export const opendir: typeof fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
  if (!installationScoped()) return fs.opendir(...args);
  let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {await effect(async () => {directory = await fs.opendir(...args);});}
  catch (error) {try {await directory?.close();} catch {throw new Error('skill_installation_cleanup_unconfirmed');} throw error;}
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {try {await directory!.close();} catch {throw new Error('skill_installation_cleanup_unconfirmed');}})();
  return {close, async *[Symbol.asyncIterator]() {
    try {while (true) {const entry = await effect(() => directory!.read()); if (!entry) return; yield entry;}}
    finally {await close();}
  }} as typeof directory;
}) as typeof fs.opendir;
