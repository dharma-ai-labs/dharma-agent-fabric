# Installation and Enrollment

## Portal-selected Linux named-Codex setup

For a deployment whose copied prompt selects `dharma setup codex --stdin`,
paste that entire public prompt into the intended genuine Codex session once.
The agent runs the exact pinned official entry and supplies the unchanged public
prompt on stdin. It must not ask the user for terminal commands, grant material,
password files or keyring troubleshooting. Never assume an older published CLI
contains this entry; follow the version actually selected by the portal.

If this session already has the exact host-bound setup tool, use that tool.
Otherwise the official entry starts an owned named setup session with that tool;
this is a disclosed handoff, not attachment to an arbitrary desktop chat. Do not
prestart a qualification controller or invent tool bindings. A denied/refused,
expired or interrupted attempt cannot select another route as a fallback.

The selected route requires the intended protected Fabric/provider homes and
existing legitimate Codex sign-in. Keep the same process pending while the exact
recipient approves the matching device in their signed-in browser. Browser
approval does not itself establish readiness. Require the original operation's
verified completion receipt and current signed repository readiness, roles,
native skills, relay and startup receipts. A public preparation or dry-run is
not enrollment or a policy lock. Do not report production qualification without
the recorded complete journey and independent guide-only rehearsal.

## Separate compatibility commands

The manual commands below describe other supported compatibility operations;
they are not fallback instructions for the portal-selected named-Codex route.

## Install

Use the published package or approved source build:

```text
npm install --global @dharma-ai-labs/agent-fabric
dharma --version
```

## Enroll the device

```text
dharma login
dharma device status --json
```

The CLI opens OAuth device authorization, generates a device key locally, and stores the private key in the operating-system keychain.

## Register a workspace

```text
dharma workspace add . --organization <organization-id> --json
dharma providers list --workspace . --json
```

Windows and WSL are separate devices. Register the repository in the environment where the provider and session evidence actually live. Avoid registering the same provider sessions from both environments.

## Confirm policy

```text
dharma policy show --workspace .
dharma evidence preview --workspace . --latest
```

Stop when the organization, repository, evidence mode, or provider coverage is not what the user expects.
