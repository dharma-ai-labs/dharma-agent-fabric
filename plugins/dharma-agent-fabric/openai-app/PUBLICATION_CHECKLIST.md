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
- [x] Privacy policy, terms, and support routes published.
- [x] Data retention and deletion behavior documented.
- [x] Final security review completed after GitHub App credential rotation and revocation proof.
- [x] Linux, Windows, and macOS CI validation passed at release commit `adb5e2105e73b91151d198e928332c5786abcdf4`.
- [x] CycloneDX SBOM generated and validated from the release lockfile in CI.
- [x] No arbitrary shell, file, secret, generic merge, or generic deployment MCP tool exposed. The admin-only `fabric_remediation_merge_pr` and the signed skill release and rollout tools are disclosed in `README.md` and `DATA_AND_SECURITY.md`.
- [x] `mcp-tool-catalog.json` and the submission tool declarations match `live-mcp-tools.snapshot.json` (`npm run mcp:catalog:verify`).
- [ ] A fresh hosted `tools/list` capture compares `compatible` with the catalog (`node scripts/verify-mcp-catalog.mjs --snapshot-manifest <manifest.json>`).
- [ ] Every submitted test case and negative case observed on ChatGPT web and ChatGPT mobile with the expected output, twice, as `REVIEWER_SEED_PLAN.md` describes.
- [ ] Placeholders substituted from the private seed receipt in the copy pasted into the OpenAI form; the substituted copy is not committed.
- [x] Mutation tools return audit correlation IDs.
- [x] Public description matches the bounded Codex and Claude adapter support.
- [x] Reviewer OAuth installation and staging reviewer script recorded; production proof is the post-deploy gate.
- [ ] OpenAI directory submission accepted.

The items left unchecked above were added after the second OpenAI review
reported test cases that did not produce the documented results. The earlier
prompts named no organization ID, which every tool requires, and one case
called `fabric_rollout_skill`, which the hosted server no longer registers.

## Deferred and external gates

- Complete the final production-host OAuth and Codex workflow proof after the
  reviewed HQ and public release branches are merged and deployed.
- Claude Sonnet 5 remains a deferred provider capability until non-zero Vertex
  AI pay-as-you-go quota is granted. The initial listing and production canary
  claim Codex support only.
- OpenAI Plugin Directory publication remains subject to OpenAI review.
