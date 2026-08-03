# Session-analysis shim dedupe and public-surface import cleanup

## Traceability

- Spec ID: session-analysis-shim-dedupe
- Status: Implemented

## Intent

`scripts/session-analysis.mjs` is documented as a thin compatibility shim in
`docs/adrs/directory-structure.md`, but today it carries a full second copy of
the `SessionAnalyzer` base class, the eight-platform `loadPlatform()` dispatch,
`createAnalyzer()`, and a `main()` that has already drifted from the copy in
`scripts/session-analysis/analyzer.mjs` (different help routing and a
`timestampMillis` edge-case divergence). Platform adapters import the base
class from the root shim while `scripts/session-analysis/index.mjs` exports the
`analyzer.mjs` copy, so the two class identities can silently fork and every
new platform must be registered twice.

Separately, several capabilities import session-analysis capability-private
modules (`fs.mjs`, `paths.mjs`, `cli.mjs`, `semantic-facets.mjs`) instead of the
public `index.mjs` surface, violating the compose-through-public-surfaces rule
in `docs/ARCHITECTURE.md`.

This change makes `analyzer.mjs` the single owner of the base class, platform
registry, and CLI `main()`, reduces the root file to the thin shim the ADR
already describes, and routes all cross-capability imports through
`scripts/session-analysis/index.mjs`.

## Acceptance Scenarios

- AC-1: `scripts/session-analysis.mjs` contains no class, dispatch, or help
  logic; it only re-exports from `scripts/session-analysis/analyzer.mjs` and
  keeps the direct-CLI entry guard. `node scripts/session-analysis.mjs --help`
  output stays byte-identical to
  `test/fixtures/scripts-refactor-contract/session-help.txt`.
- AC-2: Exactly one `SessionAnalyzer` class and one `loadPlatform()` exist under
  `scripts/`, both in `analyzer.mjs`. `loadPlatform()` resolves platforms
  through a data registry (platform -> module specifier + analyzer export)
  instead of an if-else chain, and the unsupported-platform error message is
  unchanged.
- AC-3: `createAnalyzer` imported from `scripts/session-analysis.mjs` and from
  `scripts/session-analysis/index.mjs` is the same function, and platform
  adapters extend the same `SessionAnalyzer` identity exported by both
  surfaces. The public `main(["help"])` alias continues to return the exported
  `SESSION_ANALYSIS_HELP` contract (covered by
  `test/session-analysis-providers.test.mjs`).
- AC-4: No module outside `scripts/session-analysis/` imports
  `scripts/session-analysis/<private>.mjs` directly; external consumers use
  `scripts/session-analysis/index.mjs` (or the grandfathered root shim). The
  public surface additionally exports `pathStat`, `readJson`,
  `projectSemanticFacets`, `validateSemanticFacets`, and the current frozen
  session-population binding helpers to cover existing cross-capability usage.
- AC-5: Duplicate local `readJson` helpers in
  `scripts/session-analysis/platforms/qoder.mjs` and
  `scripts/session-analysis/platforms/cursor.mjs` are replaced by a shared
  `readJson` in `scripts/session-analysis/fs.mjs`.
- AC-6: Frozen CLI contracts stay green: `npm test` passes, including
  `test/scripts-refactor-contract.test.mjs` (fixture and sha256-frozen
  outputs), `test/support-declarations.test.mjs`, and
  `test/session-analysis-claude-facets.test.mjs`.

## Non-goals

- No global `scripts/lib/` or `scripts/core/`; the directory-structure ADR
  forbids generic umbrellas, and capability-scoped helpers stay in place.
- No rewrite of bespoke per-capability `parseArgs` implementations (cloc,
  doc-link-graph, validate-canvas, packaging, ...). They are capability-owned
  CLI contracts with differing unknown-argument semantics; converging them is
  behavior-changing and out of scope.
- No change to which commands the root `better-harness` registry exposes, no
  new CLI options, and no change to any frozen stdout/stderr contract.
- No migration of existing `createAnalyzer` imports off the grandfathered root
  shim; the ADR explicitly allows existing compatibility wiring to stay.
- No splitting of oversized files (`task-loop-report.mjs`, platform adapters);
  tracked separately.

## Plan and Tasks

1. `scripts/session-analysis/analyzer.mjs` (single owner)
   - Replace its drifted `main()` with the fixture-frozen behavior currently
     living in the root file (per-command help sections for `facts`,
     `show`/`events`, and `claude-facets`), while preserving the public
     `main(["help"])` alias and the existing dependencies injection seam
     (`stdout`, `loadPlatform`).
   - Replace the if-else `loadPlatform()` with a frozen
     `PLATFORM_MODULES` registry map and derive the supported-platform error
     message from its keys so the message stays identical.
   - Keep `SESSION_ANALYSIS_HELP` (frozen by `test/support-declarations.test.mjs`
     and rendered by the root CLI facade) unchanged.
2. `scripts/session-analysis.mjs` (thin shim)
   - Reduce to shebang, AI-facing usage comment, re-exports of
     `SessionAnalyzer`, `createAnalyzer`, `main`, `SESSION_ANALYSIS_HELP`, and
     the direct-CLI guard that calls `main()` with the existing error channel.
3. Capability-internal imports
   - Point the eight `scripts/session-analysis/platforms/*.mjs` adapters plus
     `usage-summary.mjs` and `selection-profile.mjs` at `analyzer.mjs`
     directly, removing the static import cycle through the root shim.
   - Add `readJson` to `scripts/session-analysis/fs.mjs`; delete the local
     copies in `platforms/qoder.mjs` and `platforms/cursor.mjs`.
4. Public surface and cross-capability consumers
   - Extend `scripts/session-analysis/index.mjs` with `pathStat`, `readJson`,
     `projectSemanticFacets`, `validateSemanticFacets`, and any current
     session-population helpers consumed by Harness analysis.
   - Rewrite private imports to `scripts/session-analysis/index.mjs` in:
     `coding-agent-practices/checkup/{sources,apply,cli}.mjs`,
     `agent-customize/core/items.mjs`, the eight
     `agent-customize/providers/*.mjs`,
     `agent-lint/index.mjs`,
     `harness-analysis/evidence-bundle/cli.mjs`,
     `harness-analysis/report-source/source.mjs`, and
     `harness-analysis/task-loop-report.mjs`.
   - Add a scripts-refactor contract test that rejects cross-capability imports
     of session-analysis private modules regardless of relative path depth.

Decision rationale: the root file's `main()` is the live contract (the CLI
registry dispatches `session-analysis.mjs`, and the refactor-contract fixture
freezes its output), so consolidation keeps the root behavior and discards the
drifted `analyzer.mjs` copy rather than the reverse. The registry map follows
the same pattern as `better-harness-cli/registry.mjs` for command metadata.

## Test and Review Evidence

- `npm test` (full suite) — AC-1..AC-6.
- Targeted: `node --test test/scripts-refactor-contract.test.mjs
  test/session-analysis.test.mjs test/session-analysis-providers.test.mjs
  test/support-declarations.test.mjs test/session-analysis-claude-facets.test.mjs`.
- Structural gates:
  - `grep -rn "class SessionAnalyzer" scripts` returns one match.
  - `grep -rn "loadPlatform" scripts` shows a single definition site.
  - `test/scripts-refactor-contract.test.mjs` scans static and dynamic relative
    imports and rejects private session-analysis imports outside the capability.
- Risk: consumers that relied on the root shim's private drifted `main()` help
  routing; mitigated because the fixture freezes the exact bytes and the full
  suite runs frozen sha256 contracts. Cross-platform risk is low: import-path
  and data-structure changes touch no path or spawn logic, and the boundary
  test resolves specifiers with Node's platform-aware path utilities.
