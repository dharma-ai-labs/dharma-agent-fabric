# Pre-public package and metadata consistency

## Traceability

- Spec ID: pre-public-package-consistency
- Status: Implemented

## Intent

Make the repository's public npm package, CI routing, plugin metadata, internal
Skill declarations, and canonical script paths internally consistent before the
project becomes public. The maintenance must preserve supported host schemas
and cross-platform output rather than introducing compatibility fields that a
host rejects.

## Acceptance Scenarios

- **PPC-AC-1:** `npm pack` contains the Qoder, Claude, Codex, and Cursor plugin
  manifest roots, and package verification fails when any required manifest is
  missing. The Qoder-oriented runtime ZIP remains host-specific.
- **PPC-AC-2:** CI runs for pushes to `main` and for pull requests; no active
  workflow treats `master` as the default branch.
- **PPC-AC-3:** the Cursor marketplace uses the canonical `better-harness`
  identity and public description. Cursor version ownership stays in
  `.cursor-plugin/plugin.json` because the pinned official marketplace schema
  rejects a `plugins[].version` field.
- **PPC-AC-4:** `scripts/doc-link-graph/cli.mjs` is the only implementation of
  the documentation graph CLI. Its repository-relative paths and Mermaid node
  identifiers use POSIX separators on Windows, and the retired root duplicate
  is absent.
- **PPC-AC-5:** repo-local Skill guidance no longer requires a `mirror.json`
  sidecar. Each direct `.agents/skills/<skill>/` directory uses `SKILL.md` as its
  entrypoint, while wrapper routing and generated ownership stay with the skill
  instructions or generator.
- **PPC-AC-6:** repository-evidence fixtures use the canonical
  `scripts/npm-package/verify-pack.mjs` path and do not preserve the retired
  `scripts/package/` spelling.
- **PPC-AC-7:** `package.json` and all four `plugin.json` files use one public
  description, manifest versions stay aligned at `0.3.0`, and contributor docs
  describe the current `0.3.x` line.

## Non-goals

- Do not publish a package or create a release.
- Do not add unsupported Cursor marketplace fields or change the pinned Cursor
  schemas.
- Do not add non-Qoder plugin roots to the Qoder-oriented runtime ZIP.
- Do not retain a compatibility shim for the pre-public root doc-link command;
  current documentation and tests already route to the canonical CLI.
- Do not redesign plugin capabilities, Skill content, or CI test coverage.

## Plan and Tasks

1. Align npm file roots and package verification with the four supported host
   manifests while preserving the runtime ZIP boundary.
2. Route CI pushes to `main` and normalize Cursor marketplace identity without
   violating its schema.
3. Remove the duplicate root doc-link implementation and add regression
   coverage for canonical ownership and POSIX-relative paths.
4. Remove the unused mirror sidecar contract from repo-local Skill guidance and
   its architecture references.
5. Replace the stale package-script fixture path and align public descriptions
   and contributor version wording.
6. Run focused manifest, doc-link, repository-evidence, and script
   ownership tests; then run the full suite and package verification.

## Test and Review Evidence

- **PPC-AC-1, PPC-AC-3, PPC-AC-7:** `node --test
  test/plugin-manifests.test.mjs` and `npm run pack:verify` with an isolated npm
  cache when required.
- **PPC-AC-2:** inspect `.github/workflows/ci.yml` and search active workflows
  for the retired default branch name.
- **PPC-AC-4:** `node scripts/doc-link-graph/cli.mjs
  skills/better-harness`, `node --test test/doc-link-graph.test.mjs
  test/scripts-refactor-contract.test.mjs`, and `git diff --check`.
- **PPC-AC-5:** search active guidance for `mirror.json`, `mirror_type`, and the
  retired mirror validator path; only explicit sidecar-removal statements may
  remain.
- **PPC-AC-6:** `node --test
  test/task-loop-repository-evidence.test.mjs` plus a repository search for
  `scripts/package/verify-pack.mjs`.
- **Regression:** `npm test` and `npm run pack:verify`.
- **Risk review:** inspect the actual npm pack entry set, confirm the runtime
  ZIP remains Qoder-specific, confirm the Cursor schema test rejects an entry
  version, and verify no staged or unstaged files fall outside this spec.

Observed evidence on 2026-07-27:

- Focused manifest, architecture, doc-link, script-ownership, and repository
  evidence checks passed (`35/35` after the final owner-chain update).
- `npm test` passed (`825/825`).
- `npm run pack:verify` passed with 299 npm entries and 327 runtime ZIP entries.
  The five new npm entries are the two Claude, one Codex, and two Cursor
  manifest files; the runtime ZIP retained its Qoder-only shell boundary.
- Active workflow and metadata searches found no `master`,
  `better-harness-dev`, `0.1.x`, or retired package-script fixture path outside
  historical migration/spec rationale.
