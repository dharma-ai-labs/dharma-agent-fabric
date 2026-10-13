import type {CodexSetupIntent} from './codexSetupAdmission.js';
import {redactValue, type RedactionStats} from '@dharma-ai-labs/agent-fabric-evidence-reduction';

export type CodexSetupPromptBinding = Readonly<{recipientEmail: string; repositoryRemoteUrl: string}>;

/** Public fields captured from the independently verified recipient/selection. */
export function captureCodexSetupPromptBinding(value: unknown): CodexSetupPromptBinding {
  const invalid = (): never => {throw new Error('codex_setup_public_prompt_invalid');};
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (!keys.every(key => typeof key === 'string') || keys.sort().join(',') !== 'recipientEmail,repositoryRemoteUrl') return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Object.values(fields).every(field => 'value' in field)) return invalid();
  const recipientEmail: unknown = fields.recipientEmail!.value, repositoryRemoteUrl: unknown = fields.repositoryRemoteUrl!.value;
  if (typeof recipientEmail !== 'string' || recipientEmail.length > 254
    || /[\u0000-\u001f\u007f]/.test(recipientEmail)
    || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipientEmail)
    || typeof repositoryRemoteUrl !== 'string' || repositoryRemoteUrl.length > 2048
    || /[\s\u0000-\u001f\u007f]/.test(repositoryRemoteUrl)) return invalid();
  try {
    const url = new URL(repositoryRemoteUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.href !== repositoryRemoteUrl || !url.pathname.replace(/^\/+|\/+$/g, '') || url.pathname.includes('..')) return invalid();
  } catch {return invalid();}
  return Object.freeze({recipientEmail, repositoryRemoteUrl});
}

/** Presentation consistency only. The original host intent and lease, never
 * model-visible prose, remain the authority for every protected setup effect. */
export function captureCodexSetupUserPrompt(value: unknown, intent: Readonly<CodexSetupIntent>, suppliedBinding?: unknown): string | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {throw new Error('codex_setup_public_prompt_invalid');};
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 32_768
    || Buffer.from(value, 'utf8').toString('utf8') !== value
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || /--grant(?:-prompt)?(?:\s|=|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return invalid();
  const stats: RedactionStats = {classes: new Set(), redactedValues: 0, excludedPaths: 0,
    inputBytes: Buffer.byteLength(value), outputBytes: Buffer.byteLength(value)};
  redactValue(value, stats);
  // Public setup prose includes documented paths, but never secret-bearing values.
  if ([...stats.classes].some(name => name !== 'local_path')
    || /\b(?:proxy[_-]?authorization|authorization|set[_-]?cookie|cookie)["']?\s*[:=]\s*["']?\S+/i.test(value)
    || /\b(?:gh[pousr]_|github_pat_|sk_live_|sk_test_)[A-Za-z0-9_]{12,}|\bBearer\s+[A-Za-z0-9_.+-]{8,}/i.test(value)
    || /\b[A-Za-z0-9_]*(?:password|passwd|secret|api_key|access_token|refresh_token|credentials?|token)(?:_[A-Za-z0-9_]+)?["']?\s*[:=]\s*["']?[^\s"',;]+/i.test(value)) return invalid();
  const binding = captureCodexSetupPromptBinding(suppliedBinding), lines = value.split(/\r?\n/);
  const only = (prefix: string) => {
    const selected = lines.filter(line => line.startsWith(prefix));
    if (selected.length !== 1) return invalid();
    return selected[0]!;
  };
  if (lines[0] !== '# Dharma Agent Fabric \u2014 one-prompt source setup'
    || only('Recipient: ') !== `Recipient: ${binding.recipientEmail}. Organization: ${intent.organizationId}.`
    || only('Selected repository: ') !== `Selected repository: ${binding.repositoryRemoteUrl}. Fingerprint: ${intent.repositoryFingerprint}.`
    || only('Public setup reference: ') !== `Public setup reference: ${intent.setupReference}. Fixed expiry: ${intent.expiresAt}.`) {
    return invalid();
  }
  return value;
}
