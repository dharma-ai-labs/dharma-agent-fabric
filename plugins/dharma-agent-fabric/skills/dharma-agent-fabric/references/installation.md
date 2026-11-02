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

Use the published package at the exact version the portal selects, never
`latest`, or an approved source build:

```text
npm install --global @dharma-ai-labs/agent-fabric@<version-from-your-portal-prompt>
dharma --version
```

## Enroll the device

```text
dharma login --portal-url https://www.dharma-ai.io --organization-id <organization-id>
dharma status --verbose
```

The CLI opens OAuth device authorization, generates a device key locally, and stores the private key in the operating-system keychain. `dharma status` reads only local state: `enrolled: true` means a device configuration exists in this `DHARMA_HOME`, not that the device is approved or bound to a workspace. `--verbose` adds the `home`, `organizationId` and `deviceId` it read. There is no `device` command.

## Register a workspace

```text
dharma workspace add . --organization-id <organization-id>
dharma workspace sync <workspace-id> --policy-revision <revision> --apply
dharma providers list
```

`workspace add` records the checkout only in the local registry. `workspace sync --apply` registers it with Dharma, binds it to its repository agent and applies the signed policy to `.dharma/approved-policy.json`. Without `--apply` it only plans.

Windows and WSL are separate devices. Register the repository in the environment where the provider and session evidence actually live. Avoid registering the same provider sessions from both environments.

## Confirm policy

```text
dharma evidence preview --workspace . --provider <provider> --policy .dharma/approved-policy.json --maximum-sessions 20
```

There is no `policy` command; the approved policy is the signed `.dharma/approved-policy.json`. Stop when the organization, repository, evidence mode, or provider coverage is not what the user expects.
