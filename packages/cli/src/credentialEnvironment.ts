// Credential variables are read once when a CLI process starts and kept in memory.
// They are removed from process.env so that children which inherit the environment
// (Git, npm, secure-store helpers, provider CLIs, registered commands) do not see them.
// Relay processes that the CLI starts get an environment built for that spawn instead.
//
// Limits: the launching shell, service manager or parent process keeps its own copy, and
// on Linux removing a variable from process.env does not rewrite the block the process
// was started with. This keeps the variables out of Dharma's child processes; it does
// not remove them from the user's session.

const CREDENTIAL_VARIABLES = ['DHARMA_ORG_API_TOKEN', 'DHARMA_VAULT_KEY', 'DHARMA_ALLOW_ENV_KEY'] as const;
type CredentialVariable = typeof CREDENTIAL_VARIABLES[number];

const captured = new Map<CredentialVariable, string>();

function credentialName(name: string, platform: NodeJS.Platform): CredentialVariable | undefined {
  const key = platform === 'win32' ? name.toUpperCase() : name;
  return (CREDENTIAL_VARIABLES as readonly string[]).includes(key) ? key as CredentialVariable : undefined;
}

/**
 * Moves the credential variables from `env` into this process's memory. The first captured
 * value of each name is kept. On Windows every letter-case spelling is removed.
 */
export function captureCredentialEnvironment(env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): void {
  for (const key of Object.keys(env)) {
    const name = credentialName(key, platform);
    if (!name) continue;
    const value = env[key];
    if (typeof value === 'string' && !captured.has(name)) captured.set(name, value);
    delete env[key];
  }
}

/** Returns a credential variable from `source` when it is set there, otherwise the captured value. */
export function credentialVariable(name: CredentialVariable | string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = source[name];
  if (typeof value === 'string') return value;
  return captured.get(name as CredentialVariable);
}

/**
 * The environment for a relay process that this CLI starts (supervisor, relay start,
 * sessions serve): `source` without the credential variables, plus the explicit vault key
 * pair when the explicit key path is switched on. It never includes the organization token.
 */
export function relayChildEnvironment(source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !credentialName(key, platform)) environment[key] = value;
  }
  const key = credentialVariable('DHARMA_VAULT_KEY', source);
  if (credentialVariable('DHARMA_ALLOW_ENV_KEY', source) === '1' && key) {
    environment.DHARMA_ALLOW_ENV_KEY = '1';
    environment.DHARMA_VAULT_KEY = key;
  }
  return environment;
}

/** Forgets every captured value. For tests that capture in-process. */
export function resetCredentialEnvironment(): void {
  captured.clear();
}
