# Assignment-first capture selection

Classification: public API, integration and local security-boundary reference
under [the public documentation policy](PUBLIC_DOCUMENTATION_POLICY.md).

The selector is connected to an explicit, selection-only CLI dispatch mode. It
is not connected to a live owner-host export, a vault or a server. A caller must
independently qualify its binding and exact reader capability. Legacy capture
without an assignment selector or owner context remains unchanged.

## Explicit CLI Dispatch

An independently qualified in-process owner can call the exported
`run(['evidence', 'capture', '--assignment-id', assignmentId], context)` or the
`capture` alias. `AssignedCaptureCommandContext` supplies the assignment, current
binding and exact reader separately from command-line data. It does not
authenticate that context, create an assignment or grant source access.

The ordinary CLI binary has no such owner context. Supplying only an assignment
ID returns `capture_source_unavailable`; it cannot load a self-approved binding
file, infer a provider home or fall through to legacy discovery. No environment
variable, global capability, assignment file or new credential supplies this
context. A real owner-host bridge remains a separate qualification step.

The route accepts exactly one UUID assignment selector and an optional boolean
`--json`. Duplicate selectors, extra positionals, other flags, batch capture,
sync and other commands are refused before reader access. An owner context
cannot be ignored by dispatching an unrelated command or borrowed through a
bootstrap callback. The requested assignment ID must match the validated
assignment before resolving or invoking the exact reader. A mismatch is
classified as `capture_source_unavailable` without exposing a different source.

The existing selector supplies integrity, current binding/consent, expiry and
selected-record bounds checks. Dispatch returns only its metadata selection with
`persisted`, `syncAllowed`, `analysisAllowed`, `learningAdmitted` and
`nativeExecutionVerified` still false. It adds no persistence or network port.

## Implemented Boundary

`packages/cli/src/assignedCapture.ts` exposes `selectAssignedCapture`. Its runtime
contract is `schemas/capture-assignment-v1.schema.json`. An assignment selects
one existing organization/account/member/host/device/workspace/endpoint,
repository fingerprint, provider, named session and exact source locator. It
also pins source bytes, a time window, policy/consent revisions, retention and
finite byte/record limits. Sync, analysis, learning and model cost are fixed to
false/zero in this slice.

The caller must supply an independently qualified current binding, active
consent, approved assignment hash and exact allowed source locators. A
self-computed assignment hash, a fixture or an OAuth org-admin identity is not
that authority. This module checks equality and integrity; it does not
authenticate or enroll the binding. Its success says `bindingMatched`, never
verified native execution or accepted learning.

The input assignment is snapshotted and validated against the fixed bundled
schema. Missing/malformed/tampered/expired scope, changed policy or consent,
foreign repository/session/identity and disallowed locator fail before the
exact-source reader is called. Paths must already be canonical; this module
does not resolve aliases, fold case, inspect a filesystem or choose a home root.

Only a caller-supplied `readExactSession` port can obtain source data. The port
receives one frozen exact selection. No port means `capture_source_unavailable`;
there is no fallback to a default provider home, broad discovery or another
session. Errors are fixed classifications, not underlying diagnostic bodies.
The return value contains scoped selection metadata and hashes, not raw records
or source paths. Current binding/consent and expiry are checked after the read
and again before returning the result.

Reader responses are detached into a plain-data snapshot before validation or
record serialization. Accessors, executable values, custom prototypes, cycles
and unsupported data fail with a fixed error, without invoking data getters or
`toJSON` callbacks. Repeated object identities are also refused: source data must
be a JSON tree, not a shared graph that serialization can expand exponentially.
Structural admission is bounded to depth64, one million
visited values and array lengths100,000. The reader is still a trusted host
capability, not sandboxed JavaScript; this snapshot prevents returned-data
callbacks and mutation from changing an already checked output projection.

There are deliberately no vault, pending-capsule, upload, analysis or learning
ports. The explicit assignment path cannot call `listPendingCapsuleSyncs`, drain retention work,
enqueue unrelated capsules, upload evidence or increment a learning counter.
Tests include forbidden-effect traps. This does NOT repair those behaviors in
legacy capture or sync without an assignment selector/context. The explicit
route never wraps either legacy operation.

## Exact Reader Requirements

The owner-host bridge must be independently qualified before supplying this
port. It must select an already-permitted exact file/session, enforce streaming
limits before allocation, preserve genuine source hashes/provenance and gaps,
apply the current host/source/exclusion policy, and refuse held roots, secrets,
grader truth and unrelated workers/repositories. The selection module checks
reported source bytes and normalized record bounds AFTER receiving that
bounded result; it is not a streaming limiter, filesystem sandbox, redactor or
encrypted store implementation.

Do not substitute the general `ProviderAdapter.discover` implementation: some
current adapters read candidate files before filtering session IDs. The new
module reuses only the public normalized `ProviderSession` type. A real adapter
or official export bridge is a separate implementation/qualification step.

Synthetic tests cover Codex, Claude, AGY and Hermes input contracts. They do not
prove an installed provider, provider authentication, a live export bridge or
that each provider's real parser emits this exact shape. Imported and discovered
provenance remain distinct. A signed-task assertion is refused because this
slice does not implement its genuine execution-receipt verification.

## Qualification And Next Step

The initial stub produced one schema pass and thirteen failing behavior tests.
The first implementation passed fourteen tests. A later expiry-during-result
regression failed before the final freshness check was added. Independent review
then found that a returned-data callback could mutate checked output values.
Two new regressions reproduced callback injection and accessor error disclosure
before the data-only snapshot correction. A further review found shared-graph
serialization amplification; a tiny four-level graph regression failed before
shared object identities were refused (no huge payload was allocated). The final
twenty-two tests pass and
include the earlier eighteen/fourteen, not separate additive cohorts. TypeScript
build and normal bundled-schema copying were run locally on healthy C storage.
No existing full suite, native retry or paid/provider workload was replayed.

The CLI-wiring regressions initially failed eight cases while the legacy route
control passed. Nine dispatch tests now cover all four providers and Windows
and POSIX fixture paths, unavailable/mismatched capabilities, forbidden effects,
selector validation, authority separation, current guards, withdrawal and error
redaction, and the unchanged legacy control. A focused run of these nine tests,
the existing twenty-two selector tests, five command-contract tests and seven
task-caller tests passed forty-three unique tests. These are injected-port
source tests, not real session capture or provider readiness.

Independent exact-input source review precedes any merge or publication. A
future runtime integration can supply a qualified exact owner-host reader and then an
explicitly admitted selected-capsule commit/sync contract. It must retain
idempotency, lost-response reconciliation, conservative accounting, policy,
analysis-consent and pause gates. Those operations are not implemented here.

This helper alone does not establish protected-storage recovery, signing trust,
native provider readiness, end-to-end onboarding, accepted learning or guide-only
qualification. It performs no deployment, SQL, configuration, credential or access
change.
