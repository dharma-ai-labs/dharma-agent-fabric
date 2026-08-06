# Dharma Agent Fabric Remote App

The public plugin Skill should connect to a remote Dharma app implemented with MCP and the OpenAI Apps SDK.

The app authenticates the user to Dharma and exposes organization-level intent tools. It never connects directly to localhost and never receives device private keys.

## Implemented server contract

- Clerk OAuth with dynamic client registration.
- Active Dharma organization membership enforcement on every invocation.
- Tool-level Zod input contracts.
- Idempotency for every mutation.
- Explicit confirmation for sensitive evidence and mutations.
- Existing HQ audit, billing, KMS, rate-limit, and capability enforcement.
- No arbitrary shell, filesystem, chat, merge, deployment, or secret tools.

See `mcp-tool-catalog.json` for the exact registered tool surface.

## Publication

The endpoint and local contract are implemented, but deployment, reviewer-tenant
proof, security review, and OpenAI directory review remain release gates.
