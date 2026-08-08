# Installation and Enrollment

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
