# Trajectory Synchronization

## Inspect local coverage

```text
dharma evidence sources --workspace . --provider <provider> --json
dharma evidence preview --workspace . --latest --json
```

## Synchronize

```text
dharma evidence sync --workspace . --provider <provider> --json
```

The relay keeps raw evidence locally and uploads a filtered, reduced full-session capsule according to policy. Report:

- admitted and excluded sessions;
- coverage state;
- redaction classes and counts;
- uploaded and locally retained bytes;
- missing provider fields;
- trajectory and capsule IDs.

An additional server evidence request must name a purpose, byte cap, retention class, exact references, expiry, and authority. The relay re-filters the content and records a disclosure receipt.
