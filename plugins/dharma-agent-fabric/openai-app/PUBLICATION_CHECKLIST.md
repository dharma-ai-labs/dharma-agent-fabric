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
- [ ] Reviewer organization seeded exactly as `REVIEWER_SEED_PLAN.md` describes, and the seed receipt recorded privately.
- [ ] R-OAI-1 (first OpenAI rejection, incomplete privacy policy): the revised privacy policy, with the Agent Fabric data categories, content synchronization (`customer_authorized_content` and `native_provider_payload`), recipients and retention, is approved by the owner and published at `https://www.dharma-ai.io/privacy`, and `DATA_AND_SECURITY.md` matches the published text. The items below that depend on the policy stay open until then.
- [ ] Privacy policy published in its revised form (terms and support routes are already published).
- [ ] Data retention and deletion behavior documented in the revised privacy policy, and the production retention job shown to run (a recent retention receipt recorded privately).
- [x] Final security review completed after GitHub App credential rotation and revocation proof.
- [x] Linux, Windows, and macOS CI validation passed at release commit `adb5e2105e73b91151d198e928332c5786abcdf4`.
- [x] CycloneDX SBOM generated and validated from the release lockfile in CI.
- [x] No arbitrary shell, file or secret MCP tool exposed.
- [x] The submission declares only the 20-tool ChatGPT profile, which holds no merge, skill release, rollout or deployment tool (`npm run mcp:catalog:verify`).
- [ ] The ChatGPT app is not given merge or deployment tools in practice. Today the hosted server lists all 65 tools to every client, including `fabric_remediation_merge_pr` and the signed release and rollout tools, which conflicts with the `AGENTS.md` security default "No direct merge or deployment authority". [NICK-DECIDES: ship a server-side filter keyed to the ChatGPT OAuth client so ChatGPT sees only the declared profile, or amend `AGENTS.md`. This package does not amend `AGENTS.md`.]
- [x] `mcp-tool-catalog.json` matches `live-mcp-tools.snapshot.json`, and the submission tool declarations match the catalog's ChatGPT profile (`npm run mcp:catalog:verify`).
- [ ] A fresh hosted `tools/list` capture compares `compatible` with the catalog (`node scripts/verify-mcp-catalog.mjs --snapshot-manifest <manifest.json>`). Once the ChatGPT filter ships, a capture made with the ChatGPT OAuth client lists exactly the declared profile.
- [ ] Every submitted test case and negative case observed on ChatGPT web and ChatGPT mobile with the expected output, in both orders, as `REVIEWER_SEED_PLAN.md` describes. Every submitted case is a single turn that calls one read-only tool.
- [ ] Placeholders substituted from the private seed receipt in the copy pasted into the OpenAI form; the substituted copy is not committed.
- [x] Mutation tools return audit correlation IDs.
- [x] Public description matches the bounded Codex and Claude adapter support.
- [x] Reviewer OAuth installation and staging reviewer script recorded; production proof is the post-deploy gate.
- [ ] OpenAI directory submission accepted.

The items left unchecked above were added after the second OpenAI review
reported test cases that did not produce the documented results. The earlier
prompts named no organization ID, which every tool requires, and one case
called `fabric_rollout_skill`, which the hosted server no longer registers.
The privacy items were reopened because the first OpenAI review found the
privacy policy incomplete, and that fix is not yet published.

## Deferred and external gates

- Complete the final production-host OAuth and Codex workflow proof after the
  reviewed HQ and public release branches are merged and deployed.
- Claude Sonnet 5 remains a deferred provider capability until non-zero Vertex
  AI pay-as-you-go quota is granted. The initial listing and production canary
  claim Codex support only.
- OpenAI Plugin Directory publication remains subject to OpenAI review.
