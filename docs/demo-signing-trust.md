# Demo Signing Trust Delivery

This is client compatibility support, not evidence that a live rotation has completed.

The Demo client requests its enrolled signing generation on the existing signed
repository status route. A compatible server may return `signingTrustUpdate`,
conforming to `schemas/demo-signing-update.schema.json`. The response is bound to
the authenticated organization, repository and device, expires within five minutes,
and contains at most 20 immutable published keysets, including the predecessor.
An older server may omit the field. An invalid field fails closed.

The originally browser-approved public key remains unchanged in `device.json`.
A repository/device-specific OS secure-store anchor records the latest verified
keyset. First-time migration of an existing installation requires its original
pin and bootstrap keyset to be valid at the actual clock. A missing anchor cannot
establish authority from a successor's self-signature.

Updates must be contiguous. A preload retains every existing key's exact public
key and validity window, keeps its active signer and introduces one valid overlap
key. Activation may promote only a previously trusted overlap key. The server
must independently enforce compatibility, client acknowledgements and operator
delivery/acknowledgement gates before publishing that active generation; reading
or installing this response does not satisfy those server gates.

The protected anchor also records the exact pending successor introduced by a
preload. A second preload cannot replace it, and activation cannot promote a
retained historical key. A compatible enrollment poll delivers its authenticated
predecessor as the initial keyset and the published preload in `signingTrustUpdate`.
The client validates and protects that transition before saving the new device or
requesting signed status. A private, credential-free pending enrollment record
preserves the exact approved binding before the secure-store write; interrupted
setup reuses it and repairs the disk file from protected trust. A foreign or
malformed pending record fails closed without being overwritten.
Repeated enrollment polling cannot downgrade a newer
protected generation. An expired predecessor cannot authorize a new preload;
after activation, a fresh browser-approved enrollment pins the current signer.
Fixture qualification of these paths is not live rotation proof.

The caller holds the existing per-device operation lock. Protected storage is
written and read back before the disk configuration changes. A restart repairs a
stale disk generation from the protected anchor; an ahead or conflicting disk
generation is rejected. A legitimately accepted successor remains usable after
the original key expires. A client whose current protected trust expired must
use normal browser-authorized re-enrollment. No validity window is extended.

The status request's consumed sequence is saved even if an update is rejected.
No grant, credential, private key or authorization header enters the trust anchor,
package, manifest or control repository. This change does not itself issue a
signing acknowledgement, rotate a KMS key, publish a release, or enable a worker.
