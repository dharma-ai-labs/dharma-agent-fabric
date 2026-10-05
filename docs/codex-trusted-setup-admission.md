# Codex trusted setup admission: candidate boundary

This is an unregistered admission component, not a shipped onboarding route.
It must not be advertised as a working setup tool. It creates no provider
session, device, credentials, setup reference, grant or server connection.

## Separation Of Authority

`createCodexSetupAdmission` is separate from the enrolled `dharma_work` and
`dharma_bridge` handlers. It does not modify their permission profiles or tool
registry. A trusted host owns an immutable public intent and connection/thread/
turn binding. Model arguments contain only that operation ID and setup reference;
they cannot choose an executable, credential store, home, policy, repository,
environment, command or network target. Shape validation is not user approval.

The host must independently qualify the exact executable/package, repository,
protected-store boundary and applicable setup authority. The component validates
that the active context remains the same setup turn before effects and disclosure.
It refuses peer/work turns, expired intent, foreign context and unexpected input.

## Required Integration

The following are deliberately not supplied by this module:

- A supported host controller registering the dynamic tool only for the admitted
  setup operation, never through `runCodexLocalWork` or a peer handler.
- A fixed official bootstrap executor selecting host paths and immutable package
  internally, preserving genuine Codex harness attribution and recipient browser
  approval. No credential content or raw CLI output may enter the tool response.
- Independent verification of a full readiness receipt against the frozen intent.
  A receipt-shaped UUID, successful delivery or executor return is not readiness.

The executor, host qualification and readiness callbacks in the offline tests
remain synthetic stubs. They do not establish those components on either client.

## Local Journal Backend

`createCodexSetupVaultJournal` adapts the public `LocalVault` setup-operation API.
Its additive local SQLite table binds the operation to the admission's full
intent/connection digest. Atomic insertion admits one lease; only the matching
lease can write a terminal disposition. Running fences never expire or recycle
automatically. An uncertain completion stays terminal and cannot be promoted to
completed by a retry.

Terminal dispositions are encrypted with the already-supplied vault key and
authenticated against the operation and digest. The raw lease is not persisted.
Journal writes require SQLite FULL or EXTRA synchronization. This component
does not obtain a key, unlock a store, create an enrolled device, or select a
vault path. Integration must use the existing, approved protected-vault boundary.
No production database migration is part of this local table addition.

SQLite reopen/lost-acknowledgement fixtures use synthetic keys and the same
connection, thread and turn binding. They prove component persistence, not
recovery across a changed native session. An owning controller still needs a
reviewed reconciliation contract; a new context must not bypass the digest fence.

## Interruption And Reconciliation

The published transport callback defaults to 30 seconds and permits at most
60 seconds; recipient approval may remain pending for up to 15 minutes. This
awaiting admission component must not be wired to a long bootstrap and treated
as qualified. Integration requires a reviewed bounded start/status/result
contract with a separately owned operation lifecycle, or a separately reviewed
public callback lifetime contract. Neither is implemented here. Do not increase
the callback timeout or detach a credential-bearing child to bypass this gap.

Admission is serialized. A duplicate operation returns the durable terminal
disposition rather than executing again, but only after current authority and
independent readiness verification. Repeated native call IDs are denied.
An uncertain executor result or lost journal acknowledgement stays unconfirmed.
The journal's running fence remains authoritative; retry cannot create new identity.

Cancellation/close/expiry signal the owned executor cooperatively. The module
retains `pending` until that executor actually settles; it cannot prove or force
child termination. The host executor must check cancellation and current scope
at each protected effect and use its reviewed owned-child lifecycle controls.
Terminal effects are recorded even when output can no longer be disclosed.

Only allowlisted disposition fields cross the tool boundary. Runtime exceptions,
unexpected output fields and unverified readiness are withheld. No exception is
converted into a permission relaxation, store substitution or safe-to-retry claim.

## Qualification Status

Offline component tests cover foreign scope, unknown arguments, expiry, host
qualification, absent/cancelled signal, peer/work separation, readiness verification,
replay, changed payload, concurrency, journal failure and lost authority.

The separate published-transport fixture used mock server frames and a synthetic
sentinel. It established host callback wiring and representative containment only.
Neither fixture proves real Codex dynamic-tool emission, protected-store access,
bootstrap completion, restart recovery or the one-prompt customer journey.

No package publication, production change or native activation is authorized by
these test results. The proposed host route remains unqualified.
