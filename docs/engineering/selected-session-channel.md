# Selected-session channel (draft)

This is an internal integration contract, not a released CLI command or a
production-readiness claim. Companion platform draft PR1166 provides the
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

## Still Required Before Release

- Public CLI/MCP attachment and consumption commands and registration revision
  reconciliation after an ambiguous network acknowledgement. Local checkpoint
  recovery is implemented, but automatic live restart recovery remains unproven.
- A supported cooperative integration for an already-running desktop chat.
  Knowing or storing its thread ID does not authorize external app-server resume.
- Live server/KMS compatibility and actual provider turns against this channel.
  Mock transport answers and fixture receipts are not real agent answers.
- Native Windows restricted runtime compatibility; no broader filesystem access
  or unsandboxed fallback is allowed.
- Fresh two-member onboarding, actual selected-session Q&A, autonomous signed
  update use, restart recovery, revocation and EF's runtime/provider inventory.

The consumer currently drives only `dharma_bridge`-owned Codex threads. It does
not take over cooperative chats, this desktop session, or unrelated endpoints.
