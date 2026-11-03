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

// Red stub (#398): the sign-in is not checked yet.
export async function claudeSignInPreflight(_probe?: ClaudeSignInProbe): Promise<ClaudeSignInBlocker | null> {
  return null;
}
