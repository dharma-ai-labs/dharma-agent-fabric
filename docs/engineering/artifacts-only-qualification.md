# Artifacts-Only Qualification

The existing Publish Agent Fabric workflow has a separate opt-in `artifacts_only`
mode for provider0.1.38, task-runner0.1.40, relay-client0.2.35 and CLI0.2.213.
It does not publish to npm, PyPI or GitHub Releases, or install the product on a
device. The existing workflow environment and permissions are unchanged.

Use only an independently reviewed, merged exact main commit with every required
check successful. Dispatch the existing workflow with `artifacts_only=true`,
that commit as `expected_head`, and all three publication scope flags false.
This document is not dispatch authority. Reconcile an uncertain dispatch or
failed attempt before any new action; automatic reruns are refused.

Admission requires the exact source/workflow commit, current remote main, original
repository and workflow, first run attempt, clean source, and the pinned Linux
Node22.22.3/npm11.5.1 toolchain. It runs before repository dependency installation. Full
normal checks run before packing; current source is rechecked for each artifact
and before the tuple is written. Historical publisher implementations, manifest
pins and original artifact bytes are not rewritten or republished.

The result contains four newly packed archives, `artifact-qualification.json`
and `SHA256SUMS`. Existing provenance attestation covers these files. The mode
retains them for one day under a commit/run-specific artifact name, without
overwrite or hidden-file upload. Download needed evidence before expiry.

Independently verify the retained bytes, all four SHA512 integrity and SHA256
values, package names/versions, source commit, workflow/run identity and attestation
before treating the tuple as qualified. A successful local pack, Windows byte
hash, workflow exit or JSON `published=false` field is not that verification.
This mode does not reserve registry versions, qualify the entire historical or
third-party dependency closure, prove an installed consumer, authorize publication,
or establish native, learning, subsequent-use, Bruno or GA acceptance.
