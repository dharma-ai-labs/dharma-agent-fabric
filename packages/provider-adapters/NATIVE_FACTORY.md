# Native Codex factory evidence (experimental)

`@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-native-factory`
maps caller-supplied native parent/child lifecycle metadata into the existing
`ProviderSession` / `SourceRecord` evidence interface. It does not launch work.

Call `createNativeFactoryCapture(input)` with one local factory task identity,
the exact parent thread/turn and distinct child thread, reviewed instruction
hash, explicit finite scope and budget declarations, and ordered hash-only
events. Raw instructions, messages, outputs and credentials are not accepted.
Each event timestamp is its observation time; do not invent execution times.
`nativeFactoryProviderSession(capture)` validates integrity before conversion.

The first unique event must be a parent spawn. Only the child can report output;
only the parent can accept or reject the latest reported output hash. Acceptance
without integration remains `accepted` / `not_reported`. An integration hash
is a parent declaration, not independent verification of changed source.

Exact event replay is idempotent within a capture. Conflicting reused IDs,
duplicate spawn, terminal-state changes, expired/out-of-order events and unknown
recovery checkpoints fail closed. The validity window is half-open, at most
24 hours; historical replay does not renew it. Persist a checkpoint returned by
`nativeFactoryCheckpoint(capture)` and supply it as the second argument when
mapping a prefix plus new events. This detects changed context/history across
calls; it is not a server-side replay ledger.

All records remain `partial`, `evidence_only`, with caller-reported hash-only
provenance. Scope/budget declarations are not execution enforcement or verified
spend. No model, child turn, Fabric task ID, ingestion acknowledgement, signed
observation or accepted learning is inferred. Workspace policy, consent,
protected storage, signatures and server admission remain separate prerequisites
for the existing evidence pipeline. Never wrap these records as app-server
notifications or paste child events into a parent's native turn capture.

After compilation, `node scripts/export-native-factory-schema.mjs` checks the
canonical JSON schema against the runtime schema. Initial generation uses the
explicit `--write` mode and refuses to overwrite an existing schema.
