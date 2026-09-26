# Selected-session channel (draft)

This is an internal integration contract, not a released CLI command or a
production-readiness claim. Companion platform PR1166 provides the deployed
signed-device registry and inbox API. Legacy `repositories ask` starts a worker
and must not be presented as delivery to a selected provider chat.

## Channel

`createProviderSessionChannel` sends exact public binding/member/device/repository
identities through the existing signed-device transport. It never transmits a
provider session locator, workspace root, bootstrap grant, or credential. The
caller supplies current session ownership, trusted signing-key resolution and
approved-content authorization. It supports attach, heartbeat, detach, inbox,
ask, accept, reply and read. Network operations serialize within one channel.

Registration uses an explicit expected revision. Receipts must match the selected
scope, mode and next revision; a replayed receipt does not refresh presence.
Expired or detached presence is not available. Ownership is rechecked before and
after asynchronous transport and content authorization. Inbox offers require a
trusted signature, matching local scope, valid expiry and budget bounds.

Acknowledgements bind question, task correlation and recipient. Acceptance is
not an answer. Completed reads require a receipt hash and a consistent
answered/failed disposition. Malformed receipts or ambiguous delivery stop the
channel; no retargeting or implicit execution retry is permitted. Questions and
answers are bounded and checked for common credential patterns. Those checks
supplement, not replace, the caller's disclosure policy.

## Retained Codex Consumer

`openCodexInboxSession` obtains one encrypted, bridge-owned binding and retains
its app-server transport and local ownership fence. It registers that exact
binding, renews presence every 20 seconds and accepts a verified question only
after the existing provider checks and budget reservation succeed. `runNext`
performs one inbox iteration using the same selected thread. It does not open a
new worker for each question. A denied budget leaves the question unaccepted.

Completed results are encrypted and indexed by binding and question in the local
vault before upload. The immutable index survives reopening the vault and retains
acknowledged history without deleting completed evidence. If disclosure
or delivery prevents a confirmed reply, the consumer stops and reports
`reply_pending`, the encrypted completion hash, a bounded reason, and whether
provider shutdown was confirmed. It never repeats the provider turn to recover
an upload. Failed shutdown keeps the local fence. Ordinary `close` stops the
local provider and lets remote presence expire; it does not create a permanent
detach tombstone. Explicit `retire` requests server detach and reports its
acknowledgement separately from provider shutdown.

Before admitting new work, a reopened consumer reconciles one pending result.
It reads the original question, uploads only when that question is still accepted,
and requires an identical answered result with its immutable receipt hash before
marking recovery complete. Conflicting, expired, unavailable, or unconfirmed
results remain pending and stop consumption. Recovery has no provider execution
or budget-reservation API. The server must permit a question's recipient, as
well as its sender, to read that exact question; unrelated bindings remain denied.

## Observed Production Compatibility

On September 26, the reviewed platform deployment passed device-signed
registration, foreign-owner rejection and unattached-inbox rejection. Two existing
enrolled members then completed two production/KMS-signed questions through this
channel. Actual Codex 0.147.0 turns returned a synthetic marker, then recalled it
in the same retained conversation without the marker in the second question.
The sender verified both answers and immutable reply hashes; both owned provider
processes closed and their test bindings detached afterward.

The enrolled identities and credential homes were distinct, but shared one Linux
OS and existing provider authentication. This was neither a fresh onboarding run,
two-machine qualification, Bob's physical endpoint nor this current desktop chat.
Token observations remain separate from reconciled incremental provider costs.
An earlier attach transport uncertainty remains recorded with no established
root cause; subsequent successful probes do not establish general reliability.

## Still Required Before Customer Release

### Native Host Safety Gate

CLI 0.2.109 and provider-adapters 0.1.22 reject bridge-owned retained Codex
dispatch on non-Linux hosts with `codex_session_sandbox_unqualified`. The bound
consumer rejects before opening the provider or registering presence. The lower
adapter independently rejects before budget reservation, replay claim or turn
execution. Ordinary relay and enrollment capabilities are unchanged.

The September 26 native Windows Codex 0.147.0 no-model probe created a thread with
the declared read-only/no-network profile. With a disposable, unconfigured home,
outside reads, writes and loopback requests nevertheless succeeded. With the
existing configured sandbox, even the permitted-read control was rejected.
Thread creation, sandbox readiness and profile declarations are consequently
not accepted as enforcement proof. No model turn was sent. Native host rejection
tests pass; Linux bridge protocol fixtures are explicitly skipped on Windows.
Changing versions, expanding read roots or disabling restrictions is not recovery.

- Public CLI/MCP attachment and consumption commands and registration revision
  reconciliation after an ambiguous network acknowledgement. Local checkpoint
  recovery is implemented, but automatic live restart recovery remains unproven.
- A supported cooperative integration for an already-running desktop chat.
  Knowing or storing its thread ID does not authorize external app-server resume.
- Complete two-machine evidence and a qualified platform pin. CLI 0.2.108 was
  published from reviewed commit `837fc1c96a7658ae8cfd8284727cb38915a1e8a1`, but
  publication is not proof that platform prompts install this integration.
- Native Windows restricted runtime compatibility; no broader filesystem access
  or unsandboxed fallback is allowed.
- Fresh two-member onboarding, actual selected-session Q&A, autonomous signed
  update use, restart recovery and revocation. Current qualification scope is
  Codex only; other providers are not implied supported.

The consumer currently drives only `dharma_bridge`-owned Codex threads. It does
not take over cooperative chats, this desktop session, or unrelated endpoints.
