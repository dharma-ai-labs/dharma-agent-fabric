# Signing Recovery Delivery and Protected Completion

Status: source component only. This is not an available onboarding/recovery
command, an applied migration, a production release or a native recovery pass.

The new contracts candidate is 0.1.18 and relay candidate 0.2.34 (both unpublished
when prepared). Prepared CLI 0.2.210 pins both; its source version is not proof
of publication or the version served by production. The relay consumer must
use that exact compatible contract before this path is released.
The existing contracts-only 0.1.17 publication receipt remains historical;
its release script must not be replayed as publication of this candidate.

## Delivery

`sealDeviceSigningRecoveryDelivery` and `openDeviceSigningRecoveryDelivery`
use X25519, HKDF-SHA256 and AES-256-GCM. Their purpose/domain is separate from
setup credential delivery. The complete challenge is authenticated as AAD,
including device, installation, native-session digest, source, old protected
state and new signing candidate. The payload contains only public trust and
publication metadata, never a grant, API token or private signing key.

Successful decryption and a valid candidate signature are not permission to
replace trust. The authenticated owning-host path must independently verify
both current browser consents, current publication, exact device possession
and current source/session authority. That admission path is still to be wired;
there is deliberately no model-supplied `approved` switch or public installer.

## Owning-Host Completion Candidate

`recoverExpiredDeviceSigningTrust` is a typed owning-host library boundary, not
a CLI command, MCP tool, enrollment action or grant. It requires a current
`HostOperationFence`, exact local read-only recovery plan, matching challenge
and in-memory X25519 private key from the same handshake. The challenge cannot
choose local device, installation, source or native-session expectations.

The client reads the existing device key once through the official protected
store, signs the purpose-bound challenge and exact request transport with that
same in-memory key, and sends one bounded POST to the fixed same-origin recovery
path, with no cookies, bearer token or redirects. The transport recovery and
approval IDs are not a connected relay or Codex session; this readback neither
creates a protocol session/cursor nor consumes new authority.
It validates the bounded response and decrypts the matching candidate, then
replans and rechecks the exact local context. Only the relay's private callback
can enter the existing enrollment lock and journal commit. No callback,
approval boolean or arbitrary URL is accepted from a model/tool. Withdrawal or
uncertain network/write outcomes are sanitized and never retried automatically.

The narrow completion receipt explicitly says `ready:false` and
`signing_trust_installed_not_onboarding_ready`. It does not restore old-root
startup opt-in or establish actual native continuity. The server's supported
device-authenticated readback route is a separate source candidate. Initial
issuance/browser publication handshake and second-device adoption are still
unconnected: tests use synthetic stores and bounded mock HTTP, not a live
endpoint or user key.

## Protected Journal

The package-private commit primitive requires the existing enrollment lock and
owning `HostOperationFence`. It validates the expired historical signature at
its historical validity boundary, exact config/anchor hashes and the new live
candidate. It changes server trust fields and reduces legacy inline startup
selection to manual, retaining device identity, installation, enrollment time,
repository references and separate preference files.

1. Compare and replace the existing protected anchor with a versioned journal.
2. Confirm the exact protected write before replacing public configuration.
3. Write and read back the exact new configuration.
4. Compare and replace that exact journal with the new normal anchor.

Windows and WSL must use the existing shared Windows-vault conditional writer,
including both current and legacy slots. A missing CAS fails closed; there is
no `put` fallback. Linux/macOS use the existing OS-user enrollment lock. The
legacy slot is never deleted. Device-key and API-token accounts are untouched.

An old client rejects the journal's schema rather than treating it as a normal
anchor. Normal new-client startup recognizes only an already-protected exact
journal and needs a genuine current host fence to finish it. Read-only status
does not perform recovery. Changed installation, config, legacy slot or journal
bytes stop completion without overwriting the conflicting state.

The existing root-bound connection-preference guard remains intact: an old-root
automatic-resume preference becomes effectively manual after root replacement.
The replacement public configuration explicitly sets manual mode, including
legacy inline resume without any separate preference file. The protected
journal retains the previous mode only to authenticate the exact old state,
never as new-root startup authority. It does not rewrite the preference file
or resurrect an inline opt-in. Re-establishing startup
consent through the supported new-root setup flow is a separate remaining gate;
trust repair alone must not be reported as automatic reconnect readiness.

An accepted protected transaction can finish after the challenge expires; this
does not admit a new expired request. The candidate itself must remain live.
An uncertain write or cancellation preserves the journal and is not blindly
repeated. Startup uses its protected record, not a grant or model argument.

## Remaining Release Gates

- Authenticated HTTP issuance, exact browser approvals, publication and sealed
  delivery connected to this private commit boundary and current owning host.
- Independent source review, exact package pins and normal package/main release.
- Genuine protected-store capacity/durability and restart qualification on the
  approved clients; synthetic stores do not establish OS-backed behavior.
- Actual onboarding, collaboration, learning/security/budget/operations joins,
  subsequent knowledge use, Bruno proof and independent guide-only rehearsal.

No SQL, environment, KMS, trust, device, enrollment, native, model or financial
mutation is authorized or performed by source tests. Existing retry limits and
failed receipts remain unchanged.
