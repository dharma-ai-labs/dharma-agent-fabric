# Resolve a Repository Source Conflict

This operation is for an already enrolled, source-authorized workspace with a published package and no pending publication. It does not enroll a device, grant source access, sign a release or force an update. Knowledge-only members cannot use it.

When both this workspace and another publisher changed the same source file or skill, automatic reconciliation stops. Preserve the immutable baseline and both versions. Review their differences within the existing approved source paths, merge the intended behavior locally, and run the relevant tests before approving a resolution. Do not select a local version just to suppress a conflict.

The coding agent runs these commands within its existing task and workspace authority; a team member need not paste them into a separate terminal.

```bash
dharma repositories source-resolve --workspace-id <workspace-id> --dry-run
dharma repositories source-resolve --workspace-id <workspace-id> --prepare
```

The dry run does not change repository source, plans, credentials or the durable relay session. Each invocation opens a separate, memory-only authenticated protocol session and makes signed reads; this creates a server authentication/audit record, which the result reports explicitly. It cannot replay unrelated pending requests, migrate credentials or submit application writes. Preparation saves an immutable, metadata-only plan locally and returns its `planHash`, conflict paths and expiry. The plan pins the organization, workspace, repository, policy generation, baseline, reviewed local snapshot and published inventory. It contains no source bodies or credentials. Preparation alone does not approve or publish anything.

After reviewing that exact plan, explicitly choose the reviewed local versions for the listed conflicts:

```bash
dharma repositories source-resolve --workspace-id <workspace-id> --apply --plan-hash sha256:<hash> --choose-reviewed-local
```

All nonconflicting remote changes are retained. The approval expires fifteen minutes after preparation. A changed local file, skill, baseline, policy or remote inventory requires a fresh review and plan. Do not edit the plan or copy it to another workspace. Pending publication must finish before preparing another resolution.

Application only activates the plan locally. The existing relay performs reconciliation and ordinary candidate submission using the remote fingerprint as a compare-and-swap precondition. Existing evaluation, signing and installation gates still apply. `resolution_approved_for_relay` is not a publication or activation receipt: verify the subsequent candidate outcome and signed installation independently.

Malformed, expired or changed plans fail closed. No conflict approval carries into another local revision or grants peer turns write authority. Default automatic scans continue rejecting unapproved conflicts. If the relay reports a new conflict or changed context, preserve the failure and inspect the new versions rather than repeatedly applying the old plan.
