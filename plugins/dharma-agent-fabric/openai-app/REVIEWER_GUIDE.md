# Codex Plugin Reviewer Guide

## Package

- Plugin: `dharma-agent-fabric`
- MCP resource: `https://mcp.dharma-ai.io/mcp`
- OAuth metadata: `https://mcp.dharma-ai.io/.well-known/oauth-protected-resource/mcp`
- Privacy: `https://www.dharma-ai.io/privacy`
- Terms: `https://www.dharma-ai.io/terms`
- Support: `https://www.dharma-ai.io/support`

Reviewer credentials and the reviewer organization ID are supplied through the
private review channel. They are never committed to this repository.

## Review sequence

1. Install the plugin and complete Clerk OAuth.
2. Verify the signed-in identity and membership binding, then list devices,
   agents, workspaces, trajectories, Failure Atlas families, tasks, A2A
   handoffs, Skills, eval windows, and usage for the reviewer org.
3. Open one bounded trajectory only after accepting the evidence confirmation.
4. Dispatch the prepared low-risk task and verify its audit correlation ID.
5. Run the prepared 100-trajectory analysis and verify the metered usage event.
6. Inspect the prepared remediation candidate and signed bundle.
7. Start its canary rollout, inspect installation receipts, expand the rollout,
   and execute the prepared forced rollback.

## Expected authority behavior

- Cross-organization identifiers fail without revealing whether the object exists.
- Evidence expansion and every mutation require explicit confirmation.
- Reusing an idempotency key returns the durable prior result.
- The app never exposes arbitrary shell, local file, merge, deployment, or secret tools.
- Local provider credentials remain on the enrolled device.

## Support

Use `https://www.dharma-ai.io/support` for reviewer support and security escalation.
