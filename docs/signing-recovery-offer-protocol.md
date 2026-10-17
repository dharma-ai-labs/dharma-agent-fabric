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

## Remaining Integration

Official server device-principal/SQL adapters, the owning-host client calls,
recipient controls, separate owner/recipient consent, second-device adoption,
protected continuation and normal package/main release remain. This source
contract neither implements those operations nor proves them deployed. Pure
synthetic protocol tests and schemas cannot substitute for actual two-client
setup, named-task use, restart or independent guide-only rehearsal.
