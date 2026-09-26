# Scoped Demo Watch Controls

These controls are implemented in source for the next qualified CLI release. They are not commands in the already-published 0.2.103 package. Update the platform pin and copied prompt only after publishing and verifying a compatible release.

The recipient first completes the existing Demo device enrollment and explicit browser approval. Subsequent watch operations use that device's protected key and signed repository-scoped status protocol. They neither redeem another grant nor create standard-organization access.

## Commands

Run from the exact Git root. Keep the scope from the private platform envelope; do not infer it from repository URL alone:

```sh
dharma demo watch-enable --portal-url "$PORTAL" --organization-id "$ORG" --repository-id "$BINDING" --normalized-repository "$REPOSITORY" --provider codex --workspace .
dharma demo watch-status --portal-url "$PORTAL" --organization-id "$ORG" --repository-id "$BINDING" --normalized-repository "$REPOSITORY" --workspace .
dharma demo watch-disable --portal-url "$PORTAL" --organization-id "$ORG" --repository-id "$BINDING" --normalized-repository "$REPOSITORY" --workspace .
```

Enable and disable support `--dry-run`. A plan makes no registry, managed launcher, startup, enrollment, or server mutation. Supported providers are Codex, Claude, Agy and Hermes; these controls do not qualify a provider's native task execution or activation.

## Enable and Resume

Enable verifies the exact already-enrolled identity before registering the scope or changing startup. It persists no grant or credential in the registry. Startup mutations share a user-level lock with standard bootstrap, enrollment recovery and global autostart removal. The single owned Linux user service or Windows login task is registered and started; an existing compatible supervisor is reused.

The managed launcher remains package-version-pinned and selects the verified native Node runtime directory. Existing standard policy/workspace remain unchanged when a Demo scope joins the service. Windows start, replacement and removal check the task's exact action, arguments, working directory and current-user principal as well as its local ownership receipt. Principal ownership uses the SID in the exported task definition, not its potentially shortened or ambiguous display name.

Startup failure retains the scope for a grant-free retry. Report its bounded code and stage; resume the same command with the same scope once the reported condition is resolved. Never issue new credentials, edit a trust file, or move/delete customer work to work around failure.

An unknown, older or legacy supervisor is a conflict, not permission to kill it. Preserve active tasks. Use the supported relay status/stop and enrollment recovery flow only after establishing that stopping the service is safe. A bounded start observation may remain pending; the agent must poll rather than declare onboarding complete.

Standard-account rebind currently archives the standard relay namespace. When Demo watch scopes also exist, it fails with `demo_watch_standard_rebind_conflict` before signalling a process or moving files. Mixed-mode rebind requires a supported scoped recovery implementation; do not remove Demo registrations just to bypass this preservation guard.

## Status and Safety

Status revalidates the signed device and reports registration, supervisor compatibility, OS autostart and the latest bounded observation. A stale, foreign, malformed, stopped-process or different-version receipt does not establish a successful cycle. Even `demo_watch_cycle_observed` can describe delivery or source processing rather than safe activation. Every control receipt has `fullWorkflowReady: false`; obtain the separate package, first-learning, role, peer and native activation evidence before declaring the full workflow ready.

Disable removes only the exact local scope and leaves other scopes, shared startup, enrollments, workspaces, installed packages and financial records intact. It remains usable after server revocation or while offline. It unregisters future cycles; an already-in-flight bounded cycle may finish before the supervisor's next registry scan. Immediate security revocation must use the existing server membership/device/grant revocation path. Rejection of subsequent operations must be verified independently; scope removal is not global relay shutdown or credential revocation.

Publication still follows the existing repository policy, stable snapshot, expected-parent, evaluation, signing and delivery contracts. Repository isolation is unchanged. Actual autonomous publication, safe native activation, restart/offline recovery and measured use require live qualification; local control tests do not substitute for them.
