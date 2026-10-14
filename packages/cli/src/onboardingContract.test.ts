import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../AGENT_FABRIC_ONBOARDING.md', import.meta.url);

test('the installed onboarding contract forbids product-code workarounds', async () => {
  const contract = await readFile(contractUrl, 'utf8');

  assert.match(contract, /Do not modify Dharma or customer product code/i);
  assert.match(contract, /Do not create a workaround pull request/i);
  assert.match(contract, /Do not invent credentials/i);
  assert.match(contract, /do not bypass enrollment/i);
  assert.match(contract, /exact failed stage, non-sensitive error, and correlation ID/i);
  assert.match(contract, /supported retry, reconciliation, rollback, or browser-authorized re-enrollment/i);
  assert.match(contract, /same native turn pending through recipient approval and final JSON/i);
  assert.match(contract, /never replay an expired or spent setup/i);
});

test('the installed contract uses one agent-run public reference and exact recipient browser approval', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /public setup reference is not a bearer credential/i);
  assert.match(contract, /actual authenticated coding-agent conversation/i);
  assert.match(contract, /verified server-canonical public instructions \(CLI192 portal mode\)/i);
  assert.match(contract, /provided original public prompt \(legacy stdin mode\)/i);
  assert.match(contract, /Neither mode attests the enclosing human chat/i);
  assert.match(contract, /registers the matching `dharma_setup_reference` tool/i);
  assert.match(contract, /Do not run direct-CLI compatibility commands on this route/i);
  assert.match(contract, /requires `initialUserPrompt`/);
  assert.match(contract, /Missing text is refused, never replaced with a controller message/);
  assert.match(contract, /credentials move only from the trusted HTTPS endpoint into the native protected store/i);
  assert.match(contract, /never request a human terminal command, grant paste or keyring troubleshooting/i);
  assert.match(contract, /no supplementary manual setup command/i);
  assert.match(contract, /Join existing[\s\S]*No GitHub permission or source checkout is needed/i);
  assert.match(contract, /legacy Demo command contract does not establish setup-reference support/i);
  assert.doesNotMatch(contract, /recipient runs.*`--grant-prompt`|personally runs.*`--grant-prompt`|private terminal grant entry/i);
  assert.doesNotMatch(contract, /only routine human action|setup envelope contains[\s\S]*one-time grant/i);
});

test('the installed guide names the supported knowledge and peer workflow', async () => {
  const contract = await readFile(contractUrl, 'utf8');

  assert.match(contract, /repositories snapshot --workspace \. --organization-id <organization-id> --workspace-id <workspace-id> --dry-run/);
  assert.match(contract, /repositories role-discover --workspace-id <workspace-id> --category <category>/);
  assert.match(contract, /repositories ask --workspace-id <workspace-id> --target-endpoint-id <endpoint-id> --category <category> --question/);
  assert.match(contract, /repositories reply --workspace-id <workspace-id> --question-id <question-id>/);
  assert.match(contract, /reads the response rather than manually sending one/);
  assert.match(contract, /active signed release and its source references/);
  assert.match(contract, /detached task worktree is not the enrolled workspace/);
  assert.match(contract, /Do not run `dharma skills verify --workspace \.` there/);
  assert.match(contract, /report the exact denied operation/);
  assert.match(contract, /source edit, successful upload, or local snapshot alone is not publication/);
  assert.doesNotMatch(contract, /dhab_[A-Za-z0-9_-]+/);
});

test('the installed guide distinguishes canonical portal input from legacy stdin without an authority fallback', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /official `dharma setup codex` entry with `--portal-context-sha256` and `--portal-prompt-sha256`/);
  assert.match(contract, /Legacy `--stdin` remains supported for an entire original public prompt and cannot combine with either portal pin/i);
  assert.match(contract, /`nativeOriginalUserPromptAttested:false`/);
  assert.match(contract, /legacy input is not a failure fallback/i);
  assert.match(contract, /From CLI 0\.2\.193/);
  assert.match(contract, /both npm prefix and cache in a fresh private temporary directory outside the source checkout/);
  assert.match(contract, /trusted runtime files inside a mutable source checkout remain forbidden/);
  assert.doesNotMatch(contract, /both npm prefix and cache beneath the approved checkout/);
  assert.match(contract, /qualified private `DHARMA_HOME` and existing `CODEX_HOME`/);
  assert.match(contract, /not attachment to an arbitrary existing desktop chat/i);
  assert.match(contract, /never retry a refused, expired or interrupted setup/i);
  assert.doesNotMatch(contract, /When the agent has no matching registered tool, it reports/);
});

test('the installed guide scopes trusted setup approval to one native command', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /From CLI 0\.2\.194/);
  assert.match(contract, /normal one-command approval for the exact initial setup command outside the coding sandbox/);
  assert.match(contract, /Execute only after actual approval/);
  assert.match(contract, /never accept session-wide or persistent rules/);
  assert.match(contract, /denied or unavailable, stop with `codex_setup_host_execution_unqualified`/);
  assert.doesNotMatch(contract, /`setup_host_execution_unqualified`/);
  assert.match(contract, /does not authorize new source paths or network destinations/);
  assert.match(contract, /setup approval must never carry into coding or peer turns/);
  assert.doesNotMatch(contract, /--dangerously-bypass|--yolo|--sandbox danger-full-access/);
});

test('the overview separates native command approval from recipient device approval', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const overview = contract.split(/\r?\n\r?\n/)[1]!;
  assert.match(overview, /shell entry also requires the coding harness's normal command approval/);
  assert.match(overview, /configured automatic reviewer/);
  assert.doesNotMatch(overview, /recipient approves only the matching browser/);
});
