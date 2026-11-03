import { executableVersion, providerTaskReadiness } from '@dharma-ai-labs/agent-fabric-provider-adapters';

export const CLAUDE_LOGIN_REQUIRED_CODE = 'provider_claude_login_required';

export interface ClaudeSignInProbe {
  /** `claude --version`; null when the Claude Code CLI is not installed or does not run. */
  version: () => Promise<string | null>;
  /** `claude auth status`; 'available' only when it reports a signed-in account. */
  readiness: () => Promise<'available' | 'partial'>;
}

export interface ClaudeSignInBlocker {
  ok: false;
  stage: 'provider_preflight';
  code: typeof CLAUDE_LOGIN_REQUIRED_CODE;
  provider: 'claude';
  grantRedeemed: false;
  enrollmentChanged: false;
  message: string;
}

// Both probes run the CLI with the same filtered environment the relay uses for
// tasks. Only the signed-in flag is read; credentials and account details are not.
const defaultProbe: ClaudeSignInProbe = {
  version: () => executableVersion('claude'),
  readiness: () => providerTaskReadiness('claude', 'claude'),
};

/**
 * The relay runs tasks through the Claude Code CLI, which has its own sign-in,
 * separate from the Claude desktop app. Setup must not report a Claude endpoint
 * ready when that CLI cannot run a task (#398). A missing CLI is left to the
 * existing setup path, so it is not reported as a sign-in problem.
 */
export async function claudeSignInPreflight(probe: ClaudeSignInProbe = defaultProbe): Promise<ClaudeSignInBlocker | null> {
  if (!await probe.version()) return null;
  if (await probe.readiness() === 'available') return null;
  return {
    ok: false,
    stage: 'provider_preflight',
    code: CLAUDE_LOGIN_REQUIRED_CODE,
    provider: 'claude',
    grantRedeemed: false,
    enrollmentChanged: false,
    message: 'The Claude Code CLI on this device is not signed in. The relay runs tasks through that CLI, which has its own sign-in, separate from the Claude desktop app. Run `claude` in a terminal, enter /login and finish the sign-in, then rerun the same setup command. Setup has not redeemed authority or changed enrollment.',
  };
}
