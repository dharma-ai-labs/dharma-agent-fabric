# Skill Releases

## Inspect

```text
dharma skills status --workspace . --json
```

The remote app can inspect authoring branches, pull requests, release candidates, signed bundles, rollout stages, installations, and outcome evidence.

## Release

A release preview must show:

- Skill source commits;
- content hashes;
- risk class;
- historical and held-out receipts;
- target providers, repositories, and devices;
- activation mode;
- canary plan;
- rollback bundle.

## Install

Installation is automatic after a valid release targets the device. The relay stages, verifies, activates, and returns a receipt. Active tasks remain pinned.

## Roll back

```text
dharma skills rollback <bundle-id> --workspace . --json
```

Rollback must verify the previous bundle and return a signed receipt. Do not manually copy files over an active Skill directory.
