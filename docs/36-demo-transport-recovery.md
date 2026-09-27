# Demo Transport Recovery

Status: unreleased implementation in PR #168. Released CLI 0.2.110 does not
provide this command. Do not describe this document as live recovery proof.

An already enrolled Demo client may reach an operator-reviewed replacement
preview without changing its original origin, installation, device key or trust.
This does not enroll a replacement device or grant repository access.

## Connect Once

Run from the exact enrolled repository. Retain the original home/credential store
and `--hq-url`; select only the independently reviewed replacement HTTPS origin.

```sh
dharma demo transport-connect \
  --hq-url ORIGINAL_ENROLLMENT_ORIGIN \
  --organization-id ORGANIZATION_ID \
  --repository-id REPOSITORY_ID \
  --normalized-repository NORMALIZED_REPOSITORY \
  --workspace . \
  --transport-origin REVIEWED_PREVIEW_ORIGIN \
  --dry-run
```

After reviewing the plan, repeat without `--dry-run`. No setup grant, bearer
credential or browser reapproval is used. Success is `demo_transport_verified`,
not completed onboarding, package readiness or semantic learning.

The server must already have an enabled exact-origin policy pinned to its actual
Vercel and database projects. The destination cannot supply a new trust anchor.
The client accepts only a certificate authorized by its existing protected
keyset, with exact device/repository/installation scope and bounded expiry.

## Continue Automatically

Existing Demo status, package, peer, watch and client-proof operations resolve
the protected mapping. A certificate approaching expiry refreshes before work;
the work request retains its own body, signature, pending identity and sequence.
Certificate requests use a separate nonce/lease lane, not the work cursor.
Normal sequence progression occurs only when the original work completes.

Pending issuance lives in the OS protected store, separate from identity/trust.
Lost responses reuse the same logical request nonce and correlation after
restart. A failed attempt has a one-minute cooldown and three attempts per
fifteen-minute logical request. An aged or authority-changed pending request is
retained before renewal; an explicitly expired server receipt retires its nonce.
The server independently bounds fresh nonces and KMS attempts.

Invalid signatures, redirects, HTML, empty responses, foreign scope and malformed
receipts fail closed. No failure enables a fallback destination. Diagnostics
contain bounded stages/codes/correlation, not grants, keys or raw provider output.
Retain the last verified package and pending recovery after interruption.

Expired original trust requires supported browser-authorized re-enrollment;
transport recovery cannot extend it. Neither a verified certificate nor passing
fixtures proves original-client reconnect, rotation adoption or native-agent use.
