# Security and Authority

- The relay initiates every connection.
- Every server command is signed, scoped, expiring, and replay-protected.
- Raw local trajectories remain encrypted locally.
- Secrets are filtered before initial upload and evidence expansion.
- Local user controls can narrow organization policy.
- Task authority is default-deny.
- Default Git behavior is an isolated task branch.
- Skill bundles are immutable and signed.
- High-risk authority changes require explicit approval.
- App access never overrides Dharma source permissions.
- Cross-customer learning requires express contractual authorization.

Stop when a requested action requires arbitrary shell, arbitrary local file access, default-branch merge, deployment, or secret access without a dedicated approved authority path.
