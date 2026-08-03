# Observability, SLOs, and Incident Response

## Local relay metrics

- relay uptime;
- last server connection;
- capture lag;
- sessions discovered and admitted;
- sessions rejected by workspace binding;
- raw and reduced bytes;
- redaction count by class;
- spool depth and age;
- vault size;
- task queue and active tasks;
- skill bundle and activation state;
- provider capability state;
- local errors and restarts.

Metrics must not contain transcript content or secret values.

## Server metrics

- connected devices;
- reconnect rate;
- message latency;
- capsule ingestion rate and failure;
- evidence-expansion success and bytes;
- task offer, acceptance, completion, cancellation, and lease expiry;
- A2A delivery latency;
- evaluation throughput and judge use;
- failure-family creation;
- remediation validation rate;
- skill rollout coverage and rollback;
- model and environment cost;
- tenant isolation and authorization denials.

## Initial SLOs

| SLO | Target |
| --- | ---: |
| Relay control-plane availability | 99.5% monthly |
| Offline capture durability | No acknowledged capsule loss |
| Online capsule acceptance latency | 95% under 5 minutes after session close or revision |
| Control message delivery to online relay | 99% under 10 seconds |
| Task offer to accepted online device | 95% under 30 seconds |
| Skill release notification to online relay | 99% under 2 minutes |
| Low-risk bundle installation on healthy online devices | 90% under 1 hour |
| Device revocation enforcement | 99% under 5 minutes online |
| Billing event completeness | 99.99% of billable model calls |
| Cross-tenant data incident | 0 tolerated |

## Evidence quality metrics

- workspace binding confidence;
- provider session coverage;
- partial and unavailable lane rate;
- redaction rate;
- upload budget omission rate;
- expanded evidence request rate;
- deterministic verifier coverage;
- judge disagreement rate;
- unresolved failure attribution;
- post-rollout outcome coverage.

## Alerts

P0:

- cross-tenant access;
- secret uploaded despite detector;
- malicious or invalid signed release accepted;
- remote task escapes workspace;
- unauthorized merge or deployment;
- widespread corrupted Skill rollout.

P1:

- ingestion outage;
- device revocation not enforced;
- billing runaway;
- evidence expansion bypasses policy;
- repeated task duplication;
- rollback unavailable.

P2:

- provider adapter degradation;
- elevated partial evidence;
- rollout lag;
- model judge failure;
- cost estimate drift.

## Incident response

1. Detect and classify.
2. Freeze affected task or rollout authority.
3. Revoke device, key, bundle, or app token where applicable.
4. Preserve tamper-evident evidence.
5. Stop further evidence expansion if privacy is implicated.
6. Roll back Skills or relay version.
7. Notify customer according to incident contract.
8. Correct and validate.
9. Produce incident-specific Failure Atlas entry.
10. Verify current-world recovery.

## Disaster recovery

- PostgreSQL point-in-time recovery;
- object-store versioning and retention;
- GitHub skill source export;
- signed bundle archive;
- audit event backup;
- device reconnect and re-enrollment procedure;
- local vault remains usable during server recovery.

Run a quarterly recovery exercise after general availability.
