# Dharma Agent Fabric Remote App

The public plugin Skill should connect to a remote Dharma app implemented with MCP and the OpenAI Apps SDK.

The app authenticates the user to Dharma and exposes organization-level intent tools. It never connects directly to localhost and never receives device private keys.

## Required implementation

- OAuth to Dharma.
- Organization and source-permission enforcement.
- Tool-level JSON Schemas.
- Idempotency for writes.
- Cost previews.
- Action confirmation metadata.
- Audit correlation ID in every write result.
- No arbitrary shell or file tools.

See `mcp-tool-catalog.json` for the proposed tool surface.

## Publication

Revalidate the current OpenAI plugin, app, app-template, and MCP requirements before implementation and submission. OpenAI platform contracts may evolve after this package date.
