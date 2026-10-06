import {isAbsolute, resolve} from 'node:path';
import {types} from 'node:util';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {readNamedSessionPackageContent, type NamedSessionPackageContent} from './namedSessionPackageGate.js';

export type NamedCodexSkillObservation = Readonly<NamedSessionPackageContent & {
  schema: 'dharma.named-codex-skill-observation/v1';
  nativeDiscovered: true;
  observedAt: string;
}>;

/** Only the current owner's non-secret content observation crosses local IPC. */
export function parseNamedCodexSkillObservation(raw: unknown): NamedCodexSkillObservation {
  const value = data(raw);
  if (Object.keys(value).sort().join(',') !== 'bundleHash,bundleId,catalogHash,manifestHash,nativeDiscovered,observedAt,schema,skillsHash'
    || value.schema !== 'dharma.named-codex-skill-observation/v1' || value.nativeDiscovered !== true
    || typeof value.bundleId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(value.bundleId)
    || ['bundleHash', 'catalogHash', 'manifestHash', 'skillsHash'].some(key => typeof value[key] !== 'string'
      || !/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(value[key] as string))
    || typeof value.observedAt !== 'string') throw new Error('named_session_native_skill_invalid');
  const at = Date.parse(value.observedAt), now = Date.now();
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value.observedAt || at > now || now - at > 60_000) {
    throw new Error('named_session_native_skill_invalid');
  }
  return Object.freeze(value) as unknown as NamedCodexSkillObservation;
}

function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) throw new Error('named_session_native_skill_invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('named_session_native_skill_invalid');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length > 32 || Reflect.ownKeys(fields).some(key => typeof key !== 'string'
    || !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) throw new Error('named_session_native_skill_invalid');
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) throw new Error('named_session_native_skill_invalid');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== value.length + 1) throw new Error('named_session_native_skill_invalid');
  return Array.from({length: value.length}, (_, index) => {
    const field = fields[String(index)];
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new Error('named_session_native_skill_invalid');
    return field.value;
  });
}

// The owner calls this only inside its existing activation/lifetime boundary.
// Native discovery is not evidence that a later coding turn used the skill.
export async function observeNamedCodexSkill(transport: Pick<CodexStdioTransport, 'request' | 'signal'>, input: {
  workspace: string;
  installation: Parameters<typeof readNamedSessionPackageContent>[0];
  sharedRepositoryReady: boolean;
}): Promise<NamedCodexSkillObservation> {
  const captured = data(input);
  if (Object.keys(captured).sort().join(',') !== 'installation,sharedRepositoryReady,workspace'
    || typeof captured.sharedRepositoryReady !== 'boolean') throw new Error('named_session_native_skill_invalid');
  const workspace = captured.workspace;
  const installation = Object.freeze({...data(captured.installation)}) as unknown as typeof input.installation;
  const sharedRepositoryReady = captured.sharedRepositoryReady;
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace
    || workspace.length > 4096 || /[\r\n\0]/.test(workspace) || transport.signal.aborted) {
    throw new Error('named_session_native_skill_unavailable');
  }
  try {
    const before = await readNamedSessionPackageContent(installation, sharedRepositoryReady);
    if (transport.signal.aborted) throw new Error();
    // Official app-server read; no thread/turn, shell, account or configuration action.
    const response = data(await transport.request('skills/list', {cwds: [workspace], forceReload: true}));
    if (transport.signal.aborted) throw new Error();
    const entries = list(response.data, 1);
    if (entries.length !== 1) throw new Error();
    const entry = data(entries[0]);
    if (entry.cwd !== workspace || list(entry.errors, 256).length !== 0) throw new Error();
    const skills = list(entry.skills, 1024).map(data);
    const matches = skills.filter(skill => skill.name === 'dharma-agent-fabric');
    if (matches.length !== 1 || matches[0]!.enabled !== true
      || matches[0]!.path !== installation.nativeSkillPath) throw new Error();
    const after = await readNamedSessionPackageContent(installation, sharedRepositoryReady);
    if (transport.signal.aborted || (Object.keys(before) as Array<keyof NamedSessionPackageContent>)
      .some(key => before[key] !== after[key])) throw new Error();
    return parseNamedCodexSkillObservation({...after, schema: 'dharma.named-codex-skill-observation/v1',
      nativeDiscovered: true, observedAt: new Date().toISOString()});
  } catch {throw new Error('named_session_native_skill_unavailable');}
}
