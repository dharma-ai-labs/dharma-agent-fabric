# Dharma Agent Fabric for Codex

This directory is the public Codex plugin package for Dharma Agent Fabric.

It contains:

- `.codex-plugin/plugin.json`
- `.mcp.json` for the OAuth-protected remote MCP server
- `skills/dharma-agent-fabric/SKILL.md`
- Skill-local references
- `openai-app/` publication, security, and reviewer documentation

The plugin connects Codex to `https://mcp.dharma-ai.io/mcp`. The MCP server
authenticates with Clerk OAuth, enforces active Dharma organization membership,
and preserves the authority of the underlying organization APIs.

## Release verification

```bash
python /path/to/plugin-creator/scripts/validate_plugin.py ./plugins/dharma-agent-fabric
npm run mcp:catalog:verify
```

Publication remains subject to OpenAI review. Passing local validation and
reviewer-tenant proof does not imply that the plugin is listed in the Codex
directory.
