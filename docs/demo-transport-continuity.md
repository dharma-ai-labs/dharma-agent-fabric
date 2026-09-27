# Demo Transport Continuity

Status: implementation in progress; not supported by released CLI 0.2.110.
This protocol does not authorize editing an existing customer's device or trust
files. It is a recovery boundary for deployments, not a new enrollment method.

## Implemented Boundary

`packages/cli/src/demoTransportContinuity.ts` verifies the strict certificate
against a keyset already loaded from protected enrollment trust. It checks
Ed25519 signatures, every identity field, fresh request nonce, requested HTTPS
origin, exact keyset generation/hash/authorizer, monotonic policy and validity.
Inputs are snapshotted before asynchronous schema loading. Rejection messages
do not echo provider payloads or credentials. Verification has no network or
storage side effects and does not update enrollment or approve a device.

This boundary intentionally is not called by released enrollment, package or
peer commands yet. A target-supplied keyset must never be passed as protected
authority. Runtime callers must obtain that authority through the existing
protected trust loader. Before enabling routing, implement the issuer and
protected transport journal together, including refresh across signing
generations and loss of a secure-store write. An expired transport entry is
neither a new trust anchor nor permission to extend the previous one.

## Observed Failure

The two retained qualification clients bind identity, OS credential account,
signing anchor and relay registration to the immutable `22yh8944d` Vercel
deployment URL. That deployment is `dpl_6G7VLC3EjNjPz7wXNRcbUbPW9yxs`, source
`d58e6c360cf104e0f390bd2b9ad82ff662698e1d`, and has no movable alias. A new
application deployment cannot add routes to that old build. Manually changing
the saved hostname would break protected identity bindings and falsify reconnect
evidence. Replacing those devices would falsify the frozen-client rotation gate.

New onboarding must choose a verified stable API origin, never a generated
deployment URL. Existing clients need an authenticated continuity mechanism.

## Authority

Keep the original enrollment origin, device identity, private-key account,
repository binding, signing anchor and their exact validity window unchanged.
A separate server-signed certificate may authorize a replacement HTTPS API
transport for that exact enrolled device and repository. It cannot grant data
access, approve a device, extend signing validity or activate a skill release.

The certificate binds organization, repository, device, installation, device
public key, original origin, target origin, a fresh client nonce, monotonic
operator-policy revision, exact installed keyset hash/generation, issuance,
expiry and the currently trusted keyset authorizer. The server must obtain those
claims from current authenticated membership/device/repository authority, a
reviewed origin policy and anchored signing state, not arbitrary client fields.

The operator policy must establish that source and replacement origins serve
the same organization/database/signing authority. Destination authorization is
not inferred from a matching domain suffix, organization name or TLS alone.
Wrong or removed members, revoked devices/grants, another repository or tenant,
unconfigured targets and stale policies are denied before issuing a certificate.

## Client Rules

1. Load the existing protected identity and still-valid anchored trust without
   generating a key or migrating a credential account. No missing anchor may be
   manufactured from a target server's self-signed keyset.
2. Obtain the certificate only from the explicitly selected replacement origin.
   Reject redirects, userinfo, non-HTTPS URLs, noncanonical origin URLs, HTML,
   unexpected JSON, oversized bodies, invalid UTF-8 and transport errors.
3. Independently verify its signature with the existing keyset authorizer, exact
   keyset hash, complete scope, requested target and fresh nonce. Require issued
   time no later than the current clock, validity at most ten minutes, and expiry
   no later than the original trusted keyset/key validity.
4. Reject older revisions and conflicting destinations at one revision. Store
   accepted transport metadata separately in the OS secure store using confirmed
   writes and a recoverable journal. Preserve the original signing anchor and
   private-key account. Certificate replay cannot move a client backwards.
5. Every API operation resolves the authorized transport under the existing
   device-operation lock. Sign the actual path/body for the new server using the
   original protected identity. Ordinary server authorization, replay protection
   and revocation continue to apply; no bearer fallback is introduced.
6. Reconcile lost responses and process restarts from the protected journal.
   Automatically refresh same-scope continuity while current trust remains
   valid. Failed refresh retains the last verified package but cannot use an
   expired certificate or claim healthy synchronization.
7. Expired trust requires normal browser-authorized re-enrollment. An unexpired
   transport certificate does not revive an expired key or enrollment anchor.

## Release Gates

Schema or verifier tests alone do not complete recovery. Required integration:
authenticated and policy-fenced issuance, exact signer verification, protected
client persistence, bounded transport, device lock/sequence reconciliation,
watch/relay restart and prompt selection of the stable origin. Both original
qualification devices must perform real signed status, proof ingress, peer
communication and package reconciliation through the new deployment without
another grant or altered identity. Record exact source/deployment and receipts.

Test tampering, wrong scope/key/nonce, expired original trust, future/expired or
overlong certificates, replay, split same-revision targets, malformed URLs and
redirects, unavailable secure store, interrupted journal writes, lost HTTP
responses, current grant/device/member revocation and cross-tenant attempts.
Use isolated fixtures before any live signing. KMS/provider costs still require
admission under the existing qualification budget. Do not publish a release or
claim renewed trust until all relevant runtime gates are observed.
