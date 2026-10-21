# Assignment-first capture selection

This is an internal source-only adapter slice. It is not connected to a CLI
command, a live owner-host export, a vault or a server. Production CLI212 and the
existing `capture` / `evidenceSync` commands are unchanged. Root's real account,
endpoint and session assignment remains UNASSIGNED.

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
ports. The new path cannot call `listPendingCapsuleSyncs`, drain retention work,
enqueue unrelated capsules, upload evidence or increment a learning counter.
Tests include forbidden-effect traps. This does NOT repair or change those
behaviors in the older CLI paths; a future integration must not wrap those
paths and claim that this guard automatically contains their effects.

## Exact Reader Is Still Unassigned

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

Independent exact-input source review precedes any merge or publication. A
future source step can connect a qualified exact owner-host reader and then an
explicitly admitted selected-capsule commit/sync contract. It must retain
idempotency, lost-response reconciliation, conservative accounting, policy,
analysis-consent and pause gates. Those operations are not implemented here.

This work does not unblock Reviewer storage/restart eligibility, signing,
two-client production proof, automatic learning, Bruno's enrollment or guide-only
rehearsal. It adds no deployment, SQL, configuration, credential or access change.
