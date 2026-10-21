# Development Cohort Preservation

The CLI213, provider38, task-runner40 and relay-client35 versions are development
candidates, not publication or production-readiness claims. Preparing them does
not change the published CLI212 maintenance path or authorize a release.

The CLI pins every direct first-party runtime exactly. Evidence-reduction36 is
an unchanged published artifact and retains its exact provider37 dependency;
it is not silently repacked with a provider38 manifest. The lockfile therefore
contains both the current workspace adapter and a nested registry provider37
for that preserved edge. Its MCP dependency relocation keeps the same versions
and integrities; the former extraneous contracts13 entry is replaced by the
published provider37's actual contracts16 dependency.

The normal package verifier permits this one fixed combination only when the
preserved evidence manifest and Git source tree are unchanged, with no tracked
or nonignored untracked source delta. It checks the nested registry artifact's
exact version, URL and SHA512 integrity, actual package resolution and manifest,
and every non-test runtime JavaScript file against the original artifact hashes
in `scripts/preserved-evidence-provider-0.1.37.json`. Those pins were derived
from the integrity-verified original public tarball, not a local replacement.
Missing, extra or changed runtime files refuse qualification. Other stale
dependency/cohort combinations do not gain an exception.

This checks the local installed graph under normal trusted npm installation
and source custody. It is not a hostile-filesystem sandbox, cryptographic
attestation of the host, or full validation of all transitive runtime behavior.
Declarations, test files and documentation are not executable-runtime hash
coverage. The original archive integrity remains a separate pinned fact.

Historical publishers, manifests, workflow pins and release artifacts are
unchanged. A future publication still needs its own exact-source review,
canonical artifact qualification, provenance, protected finite release admission
and deployed verification. The current package verifier performs dry-run packs;
it neither publishes packages nor starts a provider or enrolled device.
