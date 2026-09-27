# Starter Lexicon

| Concept | Definition | Source |
| --- | --- | --- |
| Logical job | One tenant's requested operation identified by its idempotency key, independent of execution attempts. | AGENTS.md required behavior |
| Retry | Another execution attempt for the same logical job after interruption or uncertain delivery. | test/jobs.test.ts retry case |
| Idempotency key | A caller-supplied identifier whose tenant-scoped identity determines whether an operation has already affected state. | src/jobs.ts Job interface |

These are synthetic repository definitions. Conflicting proposals retain their
evidence and remain unresolved until validated; aliases must not silently alter meaning.
