# OpenAI Publication Checklist

Evidence snapshot: 2026-08-05. Checked items are release-candidate evidence,
not an assertion that OpenAI has approved or published the plugin.

- [x] Current Codex plugin manifest verified with the plugin validator.
- [x] Embedded Dharma Agent Fabric Skill verified with the Skill validator.
- [x] Stable MCP server deployed at `https://mcp.dharma-ai.io/mcp`.
- [x] OAuth protected-resource metadata resolves and unauthenticated MCP calls fail with `401`.
- [x] Source-system organization membership and capabilities are enforced.
- [x] Read and write tools reviewed separately.
- [x] High-risk actions require confirmation and idempotency keys.
- [x] Test organization and reviewer account prepared.
- [x] Privacy policy, terms, and support routes published.
- [x] Data retention and deletion behavior documented.
- [ ] Final security review approved after GitHub App credential rotation.
- [x] Linux, Windows, and macOS CI validation passed at release commit `adb5e2105e73b91151d198e928332c5786abcdf4`.
- [x] CycloneDX SBOM generated and validated from the release lockfile in CI.
- [x] No arbitrary shell, file, secret, merge, or deployment MCP tool exposed.
- [x] Mutation tools return audit correlation IDs.
- [x] Public description matches the bounded Codex and Claude adapter support.
- [ ] Reviewer OAuth installation and complete reviewer script recorded on the final production deployment.
- [ ] OpenAI directory submission accepted.

## External release blockers

- Rotate the GitHub App private key and client secret that were exposed outside
  the secret store, update the staging secret boundary, prove App-authenticated
  repository access, then revoke the old credentials.
- Obtain non-zero Vertex AI Claude Sonnet 5 pay-as-you-go quota before claiming
  the live Claude provider gate. Codex capture, analysis, signed install, rollout,
  and forced rollback are independently proven.
- Complete the final production-host OAuth proof after the reviewed HQ and public
  release branches are merged and deployed.
