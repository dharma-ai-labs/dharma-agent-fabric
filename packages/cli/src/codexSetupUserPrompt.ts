import type {CodexSetupIntent} from './codexSetupAdmission.js';

/** Presentation consistency only. The original host intent and lease, never
 * model-visible prose, remain the authority for every protected setup effect. */
export function captureCodexSetupUserPrompt(value: unknown, intent: Readonly<CodexSetupIntent>): string | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {throw new Error('codex_setup_public_prompt_invalid');};
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 32_768
    || Buffer.from(value, 'utf8').toString('utf8') !== value
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || /--grant(?:-prompt)?(?:\s|=|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return invalid();
  const lines = value.split(/\r?\n/);
  const only = (prefix: string) => {
    const selected = lines.filter(line => line.startsWith(prefix));
    if (selected.length !== 1) return invalid();
    return selected[0]!;
  };
  if (lines[0] !== '# Dharma Agent Fabric \u2014 one-prompt source setup'
    || !only('Recipient: ').endsWith(`. Organization: ${intent.organizationId}.`)
    || !only('Selected repository: ').endsWith(`. Fingerprint: ${intent.repositoryFingerprint}.`)
    || only('Public setup reference: ') !== `Public setup reference: ${intent.setupReference}. Fixed expiry: ${intent.expiresAt}.`) {
    return invalid();
  }
  return value;
}
