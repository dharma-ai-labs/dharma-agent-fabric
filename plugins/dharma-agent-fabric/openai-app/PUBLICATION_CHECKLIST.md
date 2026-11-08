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
- [x] Privacy policy published in its revised form, policy version `2026-10-31`, at `https://www.dharma-ai.io/privacy` since 2026-10-31 (terms and support routes are already published).
- [ ] Data retention and deletion behavior documented in the revised privacy policy, and the production retention job shown to run (a recent retention receipt recorded privately).
- [x] Final security review completed after GitHub App credential rotation and revocation proof.
- [x] Linux, Windows, and macOS CI validation passed at release commit `adb5e2105e73b91151d198e928332c5786abcdf4`.
- [x] CycloneDX SBOM generated and validated from the release lockfile in CI.
- [x] No arbitrary shell, file or secret MCP tool exposed.
- [x] The submission declares only the 20-tool ChatGPT profile, which holds no merge, skill release, rollout or deployment tool (`npm run mcp:catalog:verify`).
- [x] The ChatGPT app is not given merge or deployment tools in practice. Owner decision (Nick, 2026-10-31): ship a server-side filter keyed to the ChatGPT OAuth client so ChatGPT sees only the declared profile; `AGENTS.md` stays unchanged. The filter is live in production since platform #1909 (merge commit `724df4d7`, 2026-11-08): a ChatGPT connection sees only the 20 profile tools, with no `fabric_remediation_merge_pr`, release or rollout tool, so the `AGENTS.md` security default "No direct merge or deployment authority" holds for ChatGPT. Other clients still see all 65 tools.
- [x] `mcp-tool-catalog.json` matches `live-mcp-tools.snapshot.json`, and the submission tool declarations match the catalog's ChatGPT profile (`npm run mcp:catalog:verify`).
- [ ] A fresh hosted `tools/list` capture meets the single-capture criterion. The capture comes from a non-ChatGPT MCP client (for example MCP Inspector or `curl`) signed in as the reviewer account and is checked with the full comparison without `--profile`, using the commands in `REVIEWER_SEED_PLAN.md`, acceptance step 4, which end with `node scripts/verify-mcp-catalog.mjs --snapshot-manifest manifest.json`. One `server` capture cannot be `compatible`, so the verdict must be `unknown`, `manifestErrors` must be empty, the `server` boundary's `missingTools` and `extraTools` must both be empty (all 65 tools), its reasons may only be `confirmation_evidence_missing`, `schema_reference_missing` or `schema_unsupported` (no `annotation_mismatch`), and each other boundary must be `unknown` with the single reason `not_supplied`. Do not add confirmation values, or source, host, submitted or released snapshots, that nobody observed. ChatGPT developer mode never shows the raw `tools/list`, so the ChatGPT side is checked there: the connector lists exactly the 20 tools marked `chatgptProfile: true` in `mcp-tool-catalog.json`, and when asked to call a tool outside the profile, ChatGPT does not offer the tool and the conversation shows no `tools/call` to it. The server-side refusal (the tool is disabled for a ChatGPT client, and the route guard answers `tool_not_in_client_profile`) is covered by the platform tests `src/app/mcp/chatgptToolProfile.test.ts` and `src/lib/agent-fabric/chatgptToolProfile.test.ts` in `dharma-ai-labs/dharma-ai-platform`, not by this manual step. `--profile chatgpt` is only for a capture that really came through a ChatGPT-registered OAuth client; the usual operator cannot make one. Never refresh the 65-tool snapshot from a ChatGPT-client capture.
- [ ] Every submitted test case and negative case observed on ChatGPT web and ChatGPT mobile with the expected output, in both orders, as `REVIEWER_SEED_PLAN.md` describes. Every submitted case is a single turn that calls one read-only tool.
- [ ] Placeholders substituted from the private seed receipt in the copy pasted into the OpenAI form, and `node scripts/openai-app-submission-filled.mjs <substituted-copy.json>` passes on that copy; the substituted copy is not committed. `{{REVIEWER_ORG_ID}}` stays a placeholder in the repository until the reviewer organization exists.
- [x] Mutation tools return audit correlation IDs.
- [x] Public description matches the bounded Codex and Claude adapter support.
- [x] Reviewer OAuth installation and staging reviewer script recorded; production proof is the post-deploy gate.
- [ ] OpenAI directory submission accepted.

The items left unchecked above were added after the second OpenAI review
reported test cases that did not produce the documented results. The earlier
prompts named no organization ID, which every tool requires, and one case
called `fabric_rollout_skill`, which the hosted server no longer registers.
The privacy items were reopened because the first OpenAI review found the
privacy policy incomplete. The revised policy, version `2026-10-31`, is now
published. R-OAI-1 stays open until the owner approves `DATA_AND_SECURITY.md`
against it, and the retention item until a production retention receipt is
recorded.

## Deferred and external gates

- Complete the final production-host OAuth and Codex workflow proof after the
  reviewed HQ and public release branches are merged and deployed.
- Claude Sonnet 5 remains a deferred provider capability until non-zero Vertex
  AI pay-as-you-go quota is granted. The initial listing and production canary
  claim Codex support only.
- OpenAI Plugin Directory publication remains subject to OpenAI review.
