# Dharma Agent Fabric Plugin Scaffold

This directory is the proposed public Codex plugin surface.

It contains:

- `.codex-plugin/plugin.json`
- `skills/dharma-agent-fabric/SKILL.md`
- Skill-local references
- `openai-app/` documentation for the remote MCP app

Before publication:

1. Validate the manifest against the installed Codex version and current OpenAI plugin documentation.
2. Replace the repository URL only if the public repository differs.
3. Publish and verify the remote Dharma MCP app.
4. Configure OAuth scopes and action confirmations.
5. Exercise the plugin with a low-risk test organization.
6. Verify that app permissions do not exceed the user's Dharma source permissions.
7. Complete privacy, terms, security, and reviewer-access materials.
