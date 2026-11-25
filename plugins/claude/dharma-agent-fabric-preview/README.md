# Dharma Agent Fabric session messages (preview add-on)

`dharma-agent-fabric-preview` 1.0.7-preview is a **prototype**. It works only for the two allowlisted HQ members and only with a Dharma CLI build that has session messaging (`dharma sessions attach`, `dharma msg`, `dharma hook claude`). It is a separate marketplace entry: install it beside `dharma-agent-fabric` 1.0.6 or later, which gets no hooks.

## What's included

| Component | Purpose |
| --- | --- |
| `SessionStart` hook | Runs `dharma hook claude session-start`: records this session's id and working directory on this device only, and exports the id to later Bash calls, so `dharma sessions attach --current` names exactly this session. No network call. It exports the id before anything else, so later Bash calls know their own session even when recording fails. Prints nothing when the session is recorded. If it is not (a failing CLI, or a stall past 25 s of its 30 s timeout), it still exits 0, shows one message with the recovery `dharma hook claude session-start --session-id <uuid>` (run from the session's folder; it holds no folder name), and leaves a local note under `session-messages/claude-session-start-failures/` (`schemas/claude-session-start-failure.v1.schema.json`) that `dharma sessions attach` explains. A missing or older CLI gets an install or update message instead, at most once a day. |
| `UserPromptSubmit` hook | Runs `dharma hook claude inbox`: only when this prompt's session id is the attached session, pulls new messages, verifies each signed envelope, reports it delivered (`claude_hook`) and adds it as context, framed as untrusted text. In every other case (no CLI, not attached, a different session, messaging off, any error) it exits 0, prints nothing and pulls nothing. It never acknowledges a message. |
| Skill `name-session` | Wraps `dharma sessions attach --provider claude --current --name <name>`: a `--dry-run` plan first, then `--yes` only after the user's explicit approval. |

There is no `Stop` hook: a message waits for the user's next prompt and never starts a turn by itself.

## Limits of the preview

- The name proves the member and the device, not the session (no per-session key in the prototype).
- Messages are org-wide within the HQ allowlist; there are no per-name sender policies or block lists yet.
- Hooks run in a POSIX shell (Git Bash on Windows).
