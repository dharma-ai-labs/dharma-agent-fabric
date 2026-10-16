# Named Session Upgrade Boundary

This is the contract for the source candidate adding admission fences. It is not
present in published CLI206 or an already-running CLI204 service, and it does not
authorize a live upgrade. Production release, maintenance clearance, device
ownership, provider work and spending gates remain separate.

## Agent-Operated Sequence

1. Verify the registered device, repository, session, process creation identity,
   current source integrity and existing upgrade authority. Exclude competing
   local maintenance operators through the existing controller's operation lock.
   That file lock alone does not fence incoming peer work.
2. Generate a fresh public UUID fence identifier. Run the scoped official command:

   ```bash
   dharma sessions quiesce --name implementer --workspace-id <workspace-id> --fence-id <uuid> --apply
   ```

   Without `--apply`, this command plans only. The service synchronously rejects
   new local work, readiness/audit operations and inbox polls at their shared
   admission boundary. Work already admitted finishes, including evidence and
   health settlement; it is not cancelled by quiescence. Heartbeats continue.
3. Require the actual scoped maintenance receipt: `quiesced`, zero pending work,
   the expected binding/session and the current process generation. Record final
   work outcomes, reservations and any failed work. A timeout, stale health file,
   queued delivery or absent response does not establish a drained owner.
4. Revalidate the same process creation identity and fence, then request:

   ```bash
   dharma sessions stop --name implementer --workspace-id <workspace-id> --fence-id <uuid> --drained --apply
   ```

   The service checks the fence and zero-work boundary atomically before stopping
   admission. It disables its own automatic session registration before
   acknowledging the stop, so the supervisor cannot replace it during upgrade.
   Verify the acknowledged owned process tree exits and its lock is released.
   No forced signals are implied by this contract.
5. Only then perform the separately qualified official relay runtime upgrade and
   start the original registered session. Preserve credentials, binding, history
   and all reservations. Independently verify signed hashes and current polls.

## Abandoned Maintenance

Before a successful drained stop, the matching owner can reopen admission:

```bash
dharma sessions resume --name implementer --workspace-id <workspace-id> --fence-id <uuid> --apply
```

Resume requires the matching fence and a fully drained owner. Fences do not expire
or reopen automatically. They are process-generation-bound, not durable device
credentials. A service crash invalidates an old receipt; do not assume a restarted
service is still fenced. Reconcile its actual state before another action. A lost
response is not permission to replay work or infer successful shutdown.

## Legacy Boundary

A capable client discovers the running service before sending a maintenance
action. A legacy service returns `named_session_quiescence_not_supported` without
receiving a control request. Installing a new client cannot add this capability
to an old running process. Do not replace this guard with repeated idle snapshots,
private daemon calls, injected code, permission changes or an asserted boolean.

An initial legacy transition needs an independently approved maintenance/recovery
procedure with explicit interrupted-work disposition. Ordinary legacy `stop`
retains its interruption semantics and is not zero-work proof. No existing
enrollment or signed history is reset to qualify this boundary.
