# Returning device connection (candidate)

This guide describes the unreleased resume-first change. Use a CLI release containing
this change after its independent review and release gates pass. A successful login
probe confirms current Fabric device admission; it does not confirm provider login,
repository readiness, service restart, or task execution.

## Opt in and reconnect

Complete the normal supported setup and exact recipient browser approval first.
Keep the accepted installation's `DHARMA_HOME` and protected OS credential store.
For an already enrolled device, inspect and enable the local reconnection preference:

```sh
dharma login --unattended --dry-run
dharma login --unattended
dharma login
```

First enrollment may also include `login --unattended` with the normal organization
and portal options. The preference is saved only after enrollment is approved.
Existing configurations without a preference remain manual. `login --resume`
connects an enrolled device once without opting in; if no completed configuration
exists, the existing pending-approval resume flow remains available.

A returning login inherits the saved organization and portal. Explicit conflicting
options fail closed. It checks the installation marker, protected private key and
enrollment anchor, cached signing-trust validity, and a new server session admission.
It never generates a replacement key, starts enrollment, opens a browser, redeems a
grant, repairs signing trust, or replays the enrolled relay's durable outbox.

## Resume the approved repository

For an opted-in installation, the ordinary bootstrap invocation can omit enrollment
authority and select the existing resume flow:

```sh
dharma bootstrap --complete --portal-url <enrolled-origin> --organization-id <enrolled-org> --workspace <registered-checkout> --policy-revision <approved-revision>
```

Automatic selection requires the same device-derived workspace, repository
fingerprint, endpoint, repository binding, and approved policy revision. Missing,
ambiguous or changed scope requires supported approval. An explicit grant or public
setup reference retains its separate approval flow; reconnection does not reinterpret
that input as permission to change scope. `--dry-run` produces an effect-free plan.
Use the existing supported relay upgrade and owned startup flow for a CLI upgrade.
Do not rewrite receipts, private keys, trust, provider credentials, or shared services.

## Opt out and recovery

```sh
dharma login --no-unattended --dry-run
dharma login --no-unattended
```

This disables automatic returning-login/bootstrap selection. It does not revoke the
device or terminate an already running owned relay. To disable its standing startup
lifecycle, use the separate supported `relay autostart disable` command under the
existing owner. Server revocation and provider sign-out remain separate actions.

| Failure | Supported next step |
| --- | --- |
| Absent configuration in a genuinely new home | Normal first setup and browser approval |
| Existing installation/pending/registry without completed configuration | Preserve state; resume its supported pending setup or recover the installation |
| Corrupt/empty/invalid or unreadable configuration | Preserve the file; restore or recover the same installation |
| Missing/corrupt private key or locked/unavailable store | Restore availability or use device-bound support recovery; no plaintext or replacement-key fallback |
| Anchor mismatch or expired signing trust | Supported trust/device recovery; no manual trust edit or reenrollment retry |
| Current server authority rejected | Normal supported approval or recovery for the exact current member/device/scope |
| Temporary transport outage | Preserve enrollment and retry when connectivity returns |
| New repository, endpoint, organization or policy revision | Obtain the normal approval for the new scope |

Keep a legitimate nondefault `DHARMA_HOME` and `CODEX_HOME` unchanged. Each caller
uses only the selected home's configuration and protected identity reference.
Concurrent probes use independent in-memory protocol sessions and preserve sibling
outboxes. Provider authentication remains `not_checked` by a device login probe.

## Acceptance evidence still required

Synthetic caller, protected-store and transport fixtures verify source behavior.
They are not live admission receipts. This feature remains NOT_READY until independently
reviewed code/checks, a compatible released runtime, version-aligned guide rehearsal,
and a real bounded post-restart authorized task demonstrate the same accepted
identities, signed readiness, actual work diff and test evidence. No “forever” promise
or Done status follows from these tests.
