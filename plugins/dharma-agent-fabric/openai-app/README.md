# Dharma Agent Fabric Remote App

The public plugin Skill should connect to a remote Dharma app implemented with MCP and the OpenAI Apps SDK.

The app authenticates the user to Dharma and exposes organization-level intent tools. It never connects directly to localhost and never receives device private keys.

## Implemented server contract

- Clerk OAuth with dynamic client registration.
- Active Dharma organization membership enforcement on every invocation.
- Tool-level Zod input contracts.
- Idempotency for every mutation.
- Explicit confirmation for sensitive evidence and mutations.
- Existing platform audit, billing, KMS, rate-limit, and capability enforcement.
- Thirty bounded tools covering repository agents, setup instructions,
  trajectories, evaluation, remediation, signed rollout, and organization
  control-agent sessions.
- Control-agent reads and metered messages use the authenticated organization;
  a paid or mutating proposal requires a separate confirmed decision.
- Control-agent tool approval is restricted to an authenticated Dharma portal
  organization-admin session. A developer token or copied deep link cannot
  approve it.
- No arbitrary shell, filesystem, chat, merge, deployment, or secret tools.

See `mcp-tool-catalog.json` for the exact registered tool surface.

## Publication

The endpoint and local contract are implemented. The app remains submitted/in
review until OpenAI confirms directory approval; developer or reviewer access
does not establish public Store availability.
