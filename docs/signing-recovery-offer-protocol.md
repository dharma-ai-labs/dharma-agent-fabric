# Prepared Recovery Offer Wire Contract

This is an additive source contract in the unpublished compatible recovery
cohort. It is not a working server route, protected-store operation, new
enrollment, release, or onboarding readiness receipt.

## Fixed Operations

- `POST /api/v1/agent-fabric/signing-recovery/offers/read` accepts the read
  request schema and `read_prepared_recovery_offer` purpose only.
- `POST /api/v1/agent-fabric/signing-recovery/offers/register` accepts the
  registration request schema and `register_prepared_recovery_proof` purpose
  only. It carries exact identifiers and the existing dedicated recovery
  purpose signature, not a caller-supplied intent or candidate.

Both frames bind organization, enrolled device, immutable preparation,
request ID, nonce, canonical issuance and expiry. The runtime parser permits
at most a live 60-second request window. Device transport authentication is
separate and must bind the exact method/path/body, preparation/session ID,
request/message ID, timestamp, nonce and sequence. These transport identifiers
do not establish a connected relay or coding session. No bearer, cookie or
trusted-MCP actor may be substituted for that device route.

## Responses And Proof

Before selection, the response is `awaiting_browser_offer` with no challenge.
A retained offer is `awaiting_device_proof`; an exact already-registered proof
is `pending_approval`. All responses retain `ready: false` and
`clientTrustInstalled: false`. Registration receipts state pending approval,
never consent or protected installation.

The device receives only the public challenge, not the server's full intent,
candidate keyset, grant, token or credential. The server must authenticate the
retained intent MAC, current immutable preparation and current SQL scope before
returning it. The owning host supplies independently checked local expectations
to the response parser; no response field may replace its device, installation,
source, policy, session, history, protected-config or encryption-key binding.
The challenge must fit the original preparation deadline, use exactly the next
generation, and have a distinct root. Request/response objects are snapshotted;
caller proxies and accessors are rejected without evaluation.

The host signs the existing `deviceSigningRecoverySigningPayload` only after
its genuine current host/session fence and protected identity qualify. A new
read or registration request cannot approve browser consent, publish trust,
replay a grant, or install a credential. Registration must load the retained
server intent and recheck device possession and action-time mutable authority
in the service transaction. Lost-response retries retain the first recovery
IDs, nonce and deadline, rather than renewing authority.

## Owning-Host Client

The unpublished relay-client exports
`progressPreparedDeviceSigningRecoveryOffer`. It accepts the original public
preparation, its original in-memory X25519 private `KeyObject`, and the genuine
current source/session/host context. It is a typed owning-host API, not a CLI
option or remotely callable tool. Neither private key is a JSON argument.

The client re-derives the current local plan, verifies the original preparation
and encryption-key binding, then performs one fresh official read of the
existing enrolled Ed25519 key. It sends at most one fixed signed offer read and
one fixed signed proof registration. It rechecks local scope after each
response. It never approves consent, publishes or installs trust, updates a
credential journal, resumes a provider, or automatically retries. A lost
registration response requires a later explicitly admitted read; a retained
`pending_approval` response prevents another proof registration.

Network admission is bounded to 30 seconds per request and the shorter request
or preparation deadline. Redirects, unexpected origins, non-JSON responses,
invalid UTF-8, and responses larger than 64 KiB are rejected. Host cancellation
also bounds waiting on a non-cooperative injected fetch or response stream;
this is not a guarantee of forced process termination. Errors expose only a
fixed code, phase and HTTP status. Public progress has its own strict schema,
keeps `ready: false` and `clientTrustInstalled: false`, and omits the challenge,
signature, authenticator, keyset and encryption key.

Synthetic tests include signed serialization over an owned loopback HTTP
server. The loopback fixture is not deployed-route, TLS, OS key-store or native
session evidence. It changes no TLS settings.

## Remaining Integration

The candidate also exports an explicit owning-host connection:

1. `prepareOwnedSigningRecovery` validates the existing public config and
   protected enrollment anchor, and retains an original ephemeral X25519 key
   in process memory. It does not read the private device identity or send a
   request. The returned frozen handle is opaque; serialized copies and proxies
   have no execution authority.
2. `submitOwnedSigningRecoveryPreparation` rechecks the original source,
   session and host fence, reads the existing device key once, and submits the
   purpose-signed preparation with a separately signed transport frame. It
   accepts only the exact bounded receipt. A possible committed or lost
   response becomes `submission_unconfirmed`, with no repeat submission.
   A current shorter server expiry is retained as a stricter deadline; a later
   offer cannot extend it or register a proof outside that admitted lifetime.
3. `progressOwnedSigningRecoveryOffer` explicitly reads an offer and, if needed,
   registers the existing purpose proof. The original challenge stays inside
   the handle's owning process. Only a sanitized progress summary is returned;
   this does not approve browser consent or publish anything.
4. `completeOwnedSigningRecovery` explicitly attempts delivery once, through
   the existing protected recovery journal. The server must independently have
   the required consent and publication. Failed or uncertain delivery cannot
   silently retry, including after a later publication. Confirmed installation
   is `trust_installed` with `ready: false`, not customer readiness.

`inspectOwnedSigningRecovery` returns a saved progress snapshot, not a fresh
authority check. `disposeOwnedSigningRecovery` withdraws owned operations and
drops the handle; it does not guarantee physical memory erasure, termination
of a non-cooperative process, or rollback of an already admitted write. The
original handle is not durable across process restart. No credential, grant,
password, approval, command or replacement identity is supplied by this API.
Network waits are bounded by abort and the existing deadline. Submission
receipts have a strict 8 KiB limit; preparation requests retain 32 KiB and
delivery responses retain 64 KiB limits.

The same-package challenge handoff is not exported from the package entrypoint.
These APIs accept trusted native-host facts only; accepting a matching JSON
object from a model does not establish a genuine current Codex host/session.

The deployed native caller, official server device-principal/SQL adapters,
recipient controls, separate owner/recipient consent, second-device adoption,
protected continuation and normal package/main release remain. This source
client slice neither completes those joins nor proves them deployed. Pure
synthetic protocol tests and schemas cannot substitute for actual two-client
setup, named-task use, restart or independent guide-only rehearsal.

## Original Native-Turn Ingress

The candidate CLI exports `attachCodexSigningRecoveryNativeHost` for an
already-owned Codex transport whose original thread creation declared the fixed
tool. The original controller attaches it while that named thread is idle,
then starts only its separately admitted turn. A successful resume request is
not proof of a catalog update. The adapter does not start, resume, fork or interrupt a thread, start a
provider process, reserve funds, read authentication, or close the caller's
transport. It is not an effectful standalone CLI command.

The selected thread and source/session facts come from the qualified owning
controller, not model arguments. The adapter captures the turn ID from the
original transport's `turn/started` event. Each request must match that exact
thread/turn and a single operation ID. Only `prepare`, `submit`, `progress`,
`complete` and `status` are accepted; arguments cannot contain approvals,
credentials, paths, commands or replacement context. Peer tools and other
namespaces are rejected. The native permission profile must remain read-only
with network denied, independently of the host's fixed signed recovery HTTP.

Every protected phase rechecks the original host's side-effect-free `authorize`
decision and `current` ownership/source/account/turn qualification. The separate
recipient/owner consent and publication must already permit completion; a model
request is never that approval. The adapter calls the reviewed owning-host client
phases directly, retaining its original opaque handle and private in-memory
challenge. Public status uses a separate strict schema, always keeps `ready:
false`, and retains uncertain submission/delivery states instead of reporting an
earlier safe-looking state. Installation of trust is not onboarding readiness.

Original-turn completion, a different next turn, cancellation, transport loss
or expiry withdraws the handler and client handle. Closing waits for admitted
callbacks to settle; it does not claim a noncooperative OS operation or provider
process has terminated. A failed preparation cannot repeat protected-anchor
access in the same operation. Operation IDs cannot be reused on the same
transport. This in-process guard is not a durable retry ledger: the original
controller must preserve its existing operation, native-retry and financial
records across restarts, without replaying uncertain work on another connection.

The adapter accepts only independently qualified controller callbacks. A
matching JavaScript interface or serialized context is not proof of an owned
native transport, account or actual permission enforcement. Synthetic tests use
native-event and in-memory-store fixtures, including actual client crypto and
encrypted-delivery code. They do not qualify actual Codex tool registration,
OS-store protection, production consent or a customer journey. Deployment and
use by the existing controller remain required before live acceptance.

## Protected Original-Controller Adoption

The candidate `openCodexSigningRecoveryOwner` wraps the existing bound controller
and exposes only `beginSigningRecovery`, `assertActive` and `close` for
trusted host composition, not for peer tools or model-supplied authority. It
derives device/member/repository/session identities from its encrypted existing
binding and generates connection-context identifiers inside the original owner.
The selected native thread is not replaced. No turn, provider, peer channel,
grant, enrollment or budget reservation is started by this method.

New eligible named-thread creation declares the stable recovery tool alongside
the peer tools. Only after the original start and persistence readbacks succeed
does the controller save its declaration in a separate encrypted, binding- and
identity-scoped vault record. The legacy binding schema/bytes are unchanged. That
hash describes a creation-time declaration; it does not prove effective tool
availability, a particular installed Codex version, or actual use. The fixed
declaration grants no authority and never embeds a future operation ID. Normal
setup and peer handlers continue to refuse recovery calls.

An existing binding with missing or different protected declaration provenance returns
`codex_signing_recovery_catalog_unavailable` before recovery metadata requests,
private reads, journal claims or model dispatch. The public owner refuses it
before even opening its transport factory. Existing records are not
retrofitted, re-enrolled or replaced. In particular, the current published
[resume protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts)
does not declare a dynamic-tool replacement field. Do not send an undocumented
field, edit native history or claim that an accepted resume changed its catalog.
The existing clients' actual catalog/adoption remains a separately qualified
gate, not something established by these source fixtures.

After current ownership/source/account and the exclusive lease qualify, the
owner claims the existing durable original-operation journal under a separate
recovery-purpose digest. The digest binds the operation, protected session,
source selection, declaration and config-path hash; it contains no credential.
That claim remains consumed even when arming fails or the original owner closes.
The journal's unconfirmed/running state is not evidence of a live model turn,
successful recovery or readiness. It cannot authorize a replay after restart.
New operation IDs do not replenish native, financial or policy admission limits.

The owner remains recovery-only after admission: peer and write work cannot
carry through the recovery turn or resume automatically after it. Closure
withdraws recovery, waits for pending arming/callbacks and confirms transport
closure before releasing its original lease. Source/session revocation is
checked on both sides of awaited current-context qualification.

This is a public controller composition surface, not a newly enabled CLI or
local socket action. It does not supply missing protected source context,
change an old native catalog, restore a real service, or qualify a production
caller. Those exact original-host, OS-store, server, release and customer joins
remain required. Synthetic Linux controller fixtures must pass on Linux CI;
Windows builds cannot substitute for their execution.

The candidate pins local-vault `0.1.32`, which must be published with reviewed
provenance before CLI `0.2.210`. The published `0.1.31` artifact is immutable.
The historical CLI209 publisher and its approved package list remain unchanged
and do not admit this new cohort. A reviewed normal-main release freeze is still
required; do not widen that old guard or invoke it as a candidate publisher.
