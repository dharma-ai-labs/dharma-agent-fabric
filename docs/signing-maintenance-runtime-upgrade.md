# Signing-maintenance runtime upgrade

This is an agent-operated maintenance path for an existing Linux enrollment,
not a customer terminal step or a new enrollment flow. It does not establish
native or customer readiness. Keep the original identity, protected storage,
named session, source policy and action-specific recovery limits.

## Admission

The owning controller must first verify its exact runtime and service custody,
finish existing work and stop only its own receivers through supported controls.
The original named session must remain disabled and stopped. Unknown processes,
stale ownership, unreadable journals, foreign launchers and access denials stop
admission. This command does not remove service locks or supply stop authority.
A present named-session service lock, including one naming a dead PID, requires
supported ownership reconciliation; the staging command never removes it.

### Container Controller Handover Comes First

Staging does not upgrade PID1 or admit a different-version controller. Before
running a newer CLI in a container, its owner must complete a separately reviewed
immutable-image handover through the existing container lifecycle controls:

1. Verify the original container, controller process, image digest, configuration,
   exact persistent-volume bindings and the published target package integrity.
2. Drain current owned work and verify the original named session is disabled
   and stopped. Stop only that app container through its owned graceful lifecycle
   control and verify its controller and children are terminal. Preserve it for
   rollback. Leave protected
   credential and transport services running with their existing identities.
3. Start the qualified target image with the same user, encrypted home volume,
   source scope, limits and sandbox configuration. Never run two containers
   against that writable home. Do not export or copy credentials.
   An older registration is blocked by the target controller's runtime-version
   check without opening the protected store or starting a receiver.
4. Verify that blocked no-child state and the target controller's actual process
   and executable bytes. Use the target CLI's `relay autostart pause` plan, then
   `relay autostart pause --apply`; require fresh paused control and no child.
   The startup registration is preserved, not disabled/unregistered.
5. For a retained stopped lock, use `sessions reconcile-stopped-lock --name
   <original-name> --workspace-id <workspace> --registration-sha256 <exact-hash>
   --lock-sha256 <exact-hash>` to plan, then the same command with `--apply`.
   This requires verified paused/stopped topology and a disabled original
   registration. It preserves the exact old lock in a hash-named archive and
   changes neither registration, budget, protected storage nor session state.
   Any live/unknown owner, changed input or denied read refuses reconciliation.
6. Verify the same enrollment and named-session registration and no active lock.
   The target CLI must pass normal startup ownership inspection before staging.

A cross-version failure is a controller prerequisite, not permission to use the
rollback compatibility path, edit the running image, forge a marker or relax
ownership checks. If handover or rollback cannot be proved safe, leave the
receiver paused and retain the exact unresolved operation for its owner.

Ordinary `relay upgrade` is unchanged. It requires a fresh actual receiver poll
before reporting a successful upgrade. It is not suitable for staging a runtime
whose expired server trust must be repaired before it can poll.

## Offline Stage

The agent plans `relay upgrade --workspace <owned-checkout>
--stage-signing-maintenance`, then applies the same command with `--apply`.
The public runtime must already be integrity-qualified and available through the
normal release process. Staging verifies and records exact previous/next launcher
bytes and the existing provider-profile disposition. It writes the owned startup
registration in a paused state. It does not start a receiver, open protected
storage, perform network traffic, run a provider turn or report runtime success.
The existing startup controller is paused and its actual control state verified
before either launcher changes, and remains verified paused after staging.

A retained `rollback_failed` journal is not discarded. The agent must provide
its exact non-secret local digest with `--previous-upgrade-sha256`, and the
previous launcher and startup/profile bytes must actually be restored. The
original journal remains unchanged and is archived byte-for-byte under a
hash-bound private filename. Other unfinished states refuse staging. Local file
restoration does not retrospectively convert a failed runtime rollback to a pass.

## Trust Recovery and Finish

The existing `signing-recovery` workflow still requires its own current managed
cohort, exclusive leases, original protected binding and recipient/owner browser
consents. Staging supplies none of those approvals. Existing container-controller
version/provenance checks remain mandatory; staging does not bypass them.

Only after genuine trust recovery does the agent apply `relay upgrade
--workspace <same-checkout> --finish-signing-maintenance --apply`. Finish requires
a newer verified signing generation and the same protected enrollment anchor.
It then enables/starts the exact owned receiver and requires a fresh matching
version, process, workspace and poll receipt. Only that success writes a completed
ordinary upgrade journal, retaining the immutable original history.

An interrupted or failed finish is preserved and is not automatically replayed.
The command does not restart the old expired runtime as a fallback. Unconfirmed
stop outcomes remain unconfirmed. Even completed maintenance reports `ready:false`
and `nativeContinuationAuthorized:false`; actual native, source/task, signed
knowledge, later-use, restart and independent customer-rehearsal gates remain.
