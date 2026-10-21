# Container Startup Inspection

This additive CLI source introduces `relay container-entrypoint --inspect-startup`.
It is an explicit local inspection mode, not a startup or enrollment command.
The normal entrypoint and automatic relay restart behavior are unchanged.

The command requires the real non-root PID1 entrypoint, or the verified main
child of Docker's init, using the canonical matching CLI. A foreground shell or
ordinary `docker exec` cannot claim that context. The explicit private Dharma
home remains mandatory. Unknown, duplicate, conflicting or value-bearing
options are rejected without reflecting their values.

Inspection checks the existing private directory and opened-file ownership,
mode, type, no-follow and size guards, then reads the bounded registration and
control twice and revalidates process identity. It returns only a version,
registration hash and `unconfigured`, `paused` or `resume_requested` state.
It does not promise an atomic filesystem snapshot or authorize later execution.

No marker, lock, heartbeat or other startup state is written. No Secret Service,
relay, provider, model, network or credential consumer is invoked. `ready` and
`started` are always false. A running request is reported, never followed.

## Installation Boundary

This source mode is not yet a deployed or published capability. A Docker
container's saved Entrypoint/Cmd are immutable: upgrading binary bytes alone
does not add this flag to an existing container's `docker start`. A stopped
container cannot execute the inspection through `docker exec` either.

Live use therefore requires a separately reviewed, supported image and lifecycle
configuration handoff that selects this exact inspection invocation while
preserving approved identity, storage and containment. No replacement container,
entrypoint override, credential migration or service restart is authorized by
this document. Do not silently change ordinary restart into always-paused mode.
Do not use an unreviewed host wrapper or Docker archive as a substitute for the
private-directory and opened-descriptor checks.

Dependency-service recovery can be proposed separately while the application
remains stopped. That real protected-store operation requires its own finite
manual admission and must preserve consumed automatic retry counts.
