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
Journal writes require SQLite FULL or EXTRA synchronization and no ambient
transaction on that vault connection. A capture transaction cannot acknowledge
a journal fence or terminal result and later roll it back. The journal refuses
the overlap; it never commits or rolls back the capture's transaction. This component
does not obtain a key, unlock a store, create an enrolled device, or select a
vault path. Integration must use the existing, approved protected-vault boundary.
No production database migration is part of this local table addition.

SQLite reopen/lost-acknowledgement fixtures use synthetic keys and the same
connection, thread and turn binding. They prove component persistence, not
recovery across a changed native session. An owning controller still needs a
reviewed reconciliation contract; a new context must not bypass the digest fence.

## Interruption And Reconciliation

The published transport callback defaults to 30 seconds and permits at most
60 seconds; recipient approval may remain pending for up to 15 minutes. The
candidate now separates callback response from operation settlement. Its trusted
host response budget defaults to 250 milliseconds and is bounded at 5 seconds;
the model cannot choose it. A pending callback returns only an in-progress code,
not an approval, readiness receipt or claim of child termination. The operation
and journal fence remain owned until actual settlement. Status requests are
limited to 16 distinct native call IDs and require the original admitted binding.

The host must close the gate on transport/turn closure, interruption or scope
change and await `settled` before releasing operation resources. The executor
receives the cancellation signal and a live current-scope check; it must check
both at every protected effect and retain its actual child handles until they
stop. A returned callback is not release of execution ownership. The component
creates no child and cannot enforce a supplied executor's lifecycle by itself.
This owning-controller/executor integration is not implemented or qualified.
Do not extend transport deadlines, detach a credential-bearing child or treat
the component fixture as permission for native setup.

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
The bounded-status integration uses the public stdio adapter and an encrypted
fixture journal with a synthetic Node server. It proves status/result wiring and
normal owning-close behavior, not genuine Codex tool emission or a native worker.
No fixture proves real Codex dynamic-tool emission, protected-store access,
bootstrap completion, restart recovery or the one-prompt customer journey.

No package publication, production change or native activation is authorized by
these test results. The proposed host route remains unqualified.
