# `@dharma-ai-labs/agent-fabric`

The public `dharma` CLI connects approved local coding-agent workspaces to the
Dharma Agent Fabric control plane. It enrolls an outbound-only signed device,
discovers provider capabilities, keeps full trajectories in an encrypted local
vault, syncs policy-qualified evidence, executes bounded signed tasks, and
installs signed Skill releases with receipts and rollback ancestry.

## Recover a committed legacy bootstrap

Older repositories may contain an unsigned installer marker committed for a
different workspace. Normal onboarding rejects it. An enrolled member can plan
an explicit migration using the old workspace ID from that marker:

```powershell
dharma repositories recover-installer --workspace . --organization-id <organization-id> --workspace-id <current-workspace-id> --from-workspace-id <old-workspace-id> --dry-run
```

After inspecting the plan, replace `--dry-run` with `--apply`. Both modes require
current enrollment, the canonical device/repository binding, current signed
workspace policy and live repository-source consent. Recovery accepts only the
five unchanged, committed bootstrap files for the same repository key. Signed
bundles, custom files, staged changes, untracked files, symlinks and hardlinks
are rejected. Windows text checkout conversion is supported.

Apply preserves original bytes under `.dharma/installer-recovery/<id>` and
replaces only the unsigned installer workspace marker. It does not replace
trust, install a signed bundle, publish content or establish activation. Resume
the exact released onboarding command afterward and require its completion
receipt. Keep backups private and retain them until recovery is qualified.

## Recover a damaged local workspace registry

An enrolled device with an owned startup anchor may report
`workspace_registry_invalid` if `registry/workspaces.json` is zero bytes. The
grant-free onboarding resume attempts bounded recovery of that anchor. It
verifies the protected device enrollment, owned startup entry, signed policy,
repository fingerprint and active current-device server binding before writing
one local registry row. It preserves the original file in a private backup and
does not change server state, enrollment, startup or signed packages.

For an explicit preflight from the **actual startup-anchor checkout**:

```powershell
dharma workspace recover-registry --workspace . --dry-run
```

Use `--apply` only if the plan names the expected organization, device and
workspace. A nonempty malformed registry, foreign binding, mismatched source,
unowned startup entry or stale signed policy stops without repair. Do not edit
or replace registry/trust files by hand. Restoring local registration is not a
complete onboarding or a relay upgrade; verify the signed package and full
readiness receipt after the supported grant-free resume.

## Inspect repository worker failures

CLI 0.2.129 records sanitized per-repository worker failure stages and categories.
From the enrolled checkout, inspect `dharma status --diagnostic`. A receipt is
bound to the organization, device, workspace and observed relay PID-file state;
foreign, stale or superseded failures are not treated as current.

A healthy global relay does not prove that every repository worker is polling.
Capture the selected repository's stage/category and current-process poll before
requesting a supported repair. Diagnostics do not relax evidence policy, disclose
raw exception text, replace enrollment or establish signed readiness. Preserve
encrypted evidence; do not delete it or repeat unchanged bootstrap to bypass a
failure. Require the full readiness receipt after recovery.

## Demo peer collaboration

After a recipient approves a Demo device, run these commands for the exact
repository named by that recipient's private Demo binding. All commands require
`--organization-id`, `--repository-id`, and `--normalized-repository`; pass
`--portal-url` when using a staging portal. Source-authorized devices verify the
Git remote. Invited knowledge-only members use a dedicated non-Git directory and
pass `--knowledge-only --workspace <absolute-private-directory>` on every Demo
command. Their enrolled device key installs the same signed repository package
and receives updates without inventorying that directory or publishing source.
Neither mode grants access to another participant's repository.

```bash
dharma demo status --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote>
dharma demo role --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --role "Billing reviewer" --category "mapping"
dharma demo peers --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote>
dharma demo ask --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --recipient-device-id <uuid> --content "Which approved mapping applies?"
dharma demo inbox --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote>
dharma demo reply --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --recipient-device-id <uuid> --question-id <uuid> --content "Use the reviewed mapping."
dharma demo ack --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --message-id <uuid>
dharma demo resume --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote>
```

`demo resume` replays an interrupted signed operation before another command
is sent. An acknowledged message proves delivery, not that the recipient agent
used or correctly applied the answer. The Demo peer transport is separate from
the signed package, knowledge, Atlas, and autonomous-update readiness gates.

## Signing Upgrade Proof Preparation

For a reviewed Demo signing-consumer upgrade, an operator supplies the bounded
`dharma.signing-upgrade-context/v1` review JSON for the exact organization and
repository. It identifies the candidate, predecessor, installed preload hash,
unchanged original-client inventory, current and requested consumer versions,
and a proof expiry no more than 15 minutes away. This file is a review request,
not authorization. Never put a grant, credential or private key in it.

```bash
dharma demo signing-client-proof --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --review-context <review.json>
dharma demo signing-client-proof --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --review-context <review.json> --submit
dharma demo signing-owner-proof --organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> --review-context <review.json>
```

`--submit` records only an original enrolled client's signing-upgrade proof. It
uses the existing device key and still-valid protected preload, verifies the
exact server receipt, and preserves the same pending proof for a grant-free
retry after a lost response. Run the same command with the same review context
to resume; do not delete the pending proof or change trust files. A recorded
proof is not activation. Owner proofs still require explicit ordinary-session
browser review; `signing-owner-proof --submit` is rejected. Expired trust requires
browser-authorized re-enrollment, not a locally extended anchor.

Both commands verify the current Git remote, use the existing enrolled device
and protected, still-valid preload, and read versions from the actual installed
CLI/contracts packages. `--dry-run` verifies the repository scope and reports
only a plan; it does not attest installed trust or issue a signature.

Without `--submit`, the JSON result has `stage: "proof_prepared"` and
`submitted: false`. It contains
the device signature and source hash, not enrollment credentials. Preparing an
owner proof does not prove owner authority or approve rotation: the current
owner must separately review and confirm it in the ordinary browser session.
The server must independently check current access, preload and inventory for
every submitted source and final registration. Only client `--submit` sends the
proof. Neither command rotates or activates keys, extends trust, replaces an original client, alters
financial records, or bypass browser approval. Missing OS credentials or a
missing protected signing anchor fail without recreating them. Expired trust requires supported
browser-authorized re-enrollment, never editing local trust files.

## Autonomous organization setup

Requires Node.js 22.20.0 through 24.x.

An organization administrator copies the recipient-bound setup instruction from
the portal into the coding agent. The instruction authorizes one pinned command
and may name a selected credential-free HTTPS repository remote. A matching
current checkout is reused; otherwise the CLI clones only that remote into a
managed checkout before redeeming the grant. The coding harness may show one
native approval for the exact command; the recipient separately approves the
device in the browser.

```bash
npm exec --yes -- @dharma-ai-labs/agent-fabric@<version> bootstrap \
  --portal-url https://www.dharma-ai.io \
  --organization-id <organization-id> \
  --grant <single-use-grant> \
  --workspace . \
  --repository-url-base64url <base64url-of-selected-https-remote> \
  --policy-revision <dashboard-policy-revision> \
  --complete
```

The selected remote flag is omitted only when the command is already running
from a verified intended checkout. It is not a credential and does not alter
repository policy. A failed checkout reports `repository_selection` and leaves
the grant unused. After correcting Git access, the unchanged command may be
retried once before the grant expires; do not retry a redeemed grant. Successful
receipts include the actual `repositorySelection.workspace`; run later
repository commands from that checkout.

`bootstrap` opens the authenticated browser device-approval page. After the
recipient approves the matching fingerprint, it redeems the short-lived grant into an
Ed25519 device identity and a revocable, device-scoped organization API token,
stores both in the operating-system credential store, connects only the current
repository, obtains its signed policy, detects the active host, installs and
verifies its native skill, applies the signed evidence boundary, starts the
outbound relay, and verifies read-only organization access.
The grant is usable only until its displayed expiry and is never stored by HQ
in plaintext. Device revocation also revokes the linked organization token.

Success is one terminal JSON receipt with `ok: true`, `stage: "complete"`, a
ready provider skill, a running relay, and ready organization API reads. For
Claude Code, bootstrap also merges a project-local allowlist for later exact
read-only status commands into `.claude/settings.local.json`. Existing settings
and deny rules are preserved. The allowlist does not permit enrollment, evidence
sync, task dispatch, source writes, paid operations, release, rollout, or
rollback.

Use the separate teammate action in the Instructions tab to send a Clerk
organization invitation and copy a distinct one-time setup for that teammate.
The agent connection can complete before the teammate accepts portal access.

## Named Codex work evidence

Named Codex coding turns retain their scoped native notifications in the encrypted
local vault. The service automatically normalizes and queues a trajectory capsule
under the verified workspace evidence policy. The existing relay rechecks current
authorization, device binding and upload limits before sending it. Metadata-only
or local-analysis policies do not disclose native prompt or output content.

Work receipts include `nativeEvidence.synchronization` with `queued`, `unavailable`
or `blocked` state. `queued` means local outbox persistence, not server acceptance,
analysis, or successful learning. These notifications are partial turn evidence:
they do not establish full context, the executed model, or actual skill use, and
`acceptedLearningObservation` remains false. Peer questions are not counted as
local coding work. Queue failures preserve the actual coding result; a failed or
interrupted provider turn retains its reservation and is not replayed on restart.

## Manual enrollment

Manual browser-confirmed enrollment remains available when no one-time grant is
issued:

```bash
npm install --global @dharma-ai-labs/agent-fabric
dharma login \
  --portal-url https://www.dharma-ai.io \
  --organization-id <organization-id>
dharma repositories discover --root "$HOME/work"
dharma repositories connect \
  --repo "$PWD" \
  --provider codex \
  --provider claude \
  --provider hermes \
  --organization-id <organization-id> \
  --policy-revision <dashboard-policy-revision>
dharma repositories status --repo "$PWD" --json
```

Repeat `--provider` to attach only the local runtimes that should serve the
selected repository agent. Omitting it preserves compatibility by attaching
every installed supported provider.

One selected source repository becomes one logical organization agent and one
permanent branch in the organization's private Dharma control repository.
Connecting that repository from another machine or provider adds an endpoint to
the same agent. The CLI derives repository identity from a credential-free
normalized Git remote. Repositories without a remote require an explicit stable
`--repository-key`; absolute paths are never identity.

Current provider adapters are Codex, Claude Code, Agy, and Hermes Agent. Run
`dharma providers list` because evidence, task, continuation, Skill installation,
activation, and usage capabilities are reported independently.

Agy 1.1.15 Skill activation uses only its supported plugin and sandboxed print
interfaces. During onboarding, Dharma adds the narrow read-only
`command(git status)` preflight to Agy's permission allowlist. It never uses
`--dangerously-skip-permissions`. A signed remediation Skill contains a
content-bound activation token; Agy must return that token with a fresh nonce
before the device signs an active installation receipt. A mismatch restores the
previous bundle before the receipt is posted.

Signed workspace registration returns the organization-admin-approved evidence
policy from Dharma HQ. The CLI applies that server revision to
`.dharma/approved-policy.json` automatically. Without an active content grant,
the policy remains `local_analysis`; with a current bounded grant, it switches
to `customer_authorized_content` with the server-issued receipt and upload
limits. A local flag or hand-edited receipt cannot grant content disclosure.
The running relay refreshes this policy from signed workspace registration every
minute, so an admin grant or withdrawal does not require a manual sync command.

Local metadata analysis is operational triage, not semantic Cognitive Integrity
evaluation. Nuanced scoring and remediation require approved, redacted evidence;
missing evidence must produce `insufficient_evidence`.

## Managed evaluation workflow

Download the versioned task-package template and JSON Schema from the production
documentation, replace the example task with customer evidence, and validate the
exact contract and maximum credit charge before launching:

```bash
curl -fsSLO https://www.dharma-ai.io/templates/managed-evaluation-task-package-v1.json

dharma evaluations validate \
  --file managed-evaluation-task-package-v1.json \
  --agent-id <active-managed-agent-id> \
  --organization-id <organization-id>

dharma evaluations launch \
  --file managed-evaluation-task-package-v1.json \
  --agent-id <active-managed-agent-id> \
  --organization-id <organization-id> \
  --confirm
```

`validate` is read-only. It returns task count, trajectory count, configured
standard hard gates, maximum credits, and invoice-equivalent value without
running a model or debiting credits. `launch` repeats server validation and
requires explicit confirmation before creating the paid campaign. The package
always applies the standard Cognitive Integrity profile; an optional versioned
customer-domain rubric adds governed semantic or registered deterministic
dimensions without executing customer-supplied code.

```bash
dharma evaluations status --campaign-id <campaign-id> --organization-id <organization-id>
dharma evaluations results --campaign-id <campaign-id> --organization-id <organization-id>
```

`results` returns the persisted authoritative verdict used by the portal and
Control Agent. Scorer-only hidden truth is never returned by the read API.

After a candidate pull request exists, an organization admin first authorizes
the candidate on one exact local endpoint. This is an evaluation-only canary,
not release approval:

```bash
dharma remediations act \
  --organization-id <organization-id> \
  --target-id <repository-remediation-target-id> \
  --action stage_evaluation \
  --json-body '{"endpointId":"<local-endpoint-id>"}' \
  --confirm
```

Run `dharma skills sync` with the returned evaluation authorization ID, then
collect 20 later non-source trajectories on that endpoint. The held-out gate
rejects trajectories that do not carry the installed candidate bundle ID:

```bash
dharma skills sync \
  --workspace-id <workspace-id> \
  --provider <codex|claude|agy|hermes> \
  --policy .dharma/approved-policy.json \
  --approval-id <evaluation-authorization-id>

dharma remediations act \
  --organization-id <organization-id> \
  --target-id <repository-remediation-target-id> \
  --action run_backtest \
  --body-file held-out-trajectories.json \
  --confirm
```

`held-out-trajectories.json` contains a `trajectoryIds` array with 20 to 100
UUIDs for that repository agent. HQ rejects source, older, cross-agent, deleted,
or unavailable evidence.

- [Dharma AI](https://www.dharma-ai.io)
- [Evaluation task package and API](https://www.dharma-ai.io/docs/evaluations)
- [Source and issue tracker](https://github.com/dharma-ai-labs/dharma-agent-fabric)
- [Customer onboarding guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)
- [CLI command contract](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/22-cli-command-contract.md)
- [Security boundary](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/10-security-privacy-and-threat-model.md)

## Owning-runtime session integration

The library exports `openCooperativeInboxSession` for an integration running in
the intended Codex session. It requires that runtime's exact active-session hook,
an enrolled identity, encrypted cooperative binding, signed channel, durable
single-use replay claim, disclosure authorization and budget reservation. The
runtime handles each bounded read-only question within its own existing turn.
It must enforce the question's authorized paths and network limits.

This consumer does not create/resume another thread or wake an idle desktop chat.
It is not an installed native host hook or a CLI/MCP attachment command. Session
IDs from environment variables or historical transcripts are not ownership proof.
See [session routing](../../docs/24-provider-session-routing.md) for the exact
contract, failure recovery and remaining live qualification boundaries.

## Named coding work evidence

On a source-authorized named Codex endpoint, the activation boundary can retain
before/after approved repository inventories in the encrypted local vault. This
requires the current customer-authorized evidence policy as well as the selected
repository's source policy. Peer read-only questions do not capture source state.
Join-only membership does not grant source-capture or publication authority.

The native work receipt reports hashes, the verified active bundle, and an
explicit blocked/not-authorized disposition if capture fails or consent changes.
When available, the boundary also retains this exact thread's public history
and configured model/provider using the Codex app-server. Protected reasoning
is removed; credentials, a changed thread/workspace, nonterminal history, or
oversized history block learning preparation. The encrypted history is linked
by hash along with the reported Codex runtime version. This is task-level public
context, not an exact replay of hidden context or proof of the executed model.

Repository bytes and history are not included in the public receipt. Capture failure does
not retry the coding task or replace its actual outcome. Retained snapshots are
local inventories, not signed releases or independent grades; they do not enter
the accepted learning counter. Server intake, trusted independent grading,
logical-work deduplication, and live qualification are still required.

Named task receipts pin manifest, knowledge catalog and skill-tree hashes from
the verified active bytes, not a fresh inventory or a caller's declarations.
The device-targeted delivery bundle ID is not the shared repository release ID;
server admission must resolve the logical release separately from those content
hashes. Codex task-level history must not be relabeled as exact native replay or
routed through the managed Gemini replay adapter.

When current signed content policy permits it, named work also prepares an
encrypted `dharma.codex-task-replay-export/v1` artifact. It removes local paths,
protected reasoning and sensitive fields using the shared disclosure reducer;
configured excluded material produces an explicit excluded disposition. Original
capture, request, event and public-context digests remain separate from the
portable projection's digests. The portable context has its own schema identity.
Work receipts expose only `portableExport` status and its blob hash, never the
artifact content or a bootstrap grant. Policy scope, expiry, immutability and
size are checked again during preparation. The artifact is task-level evidence,
not native-wire replay, a publication, an independent grade or an admitted
learning observation. This local preparation does not upload it. Server retention,
device authentication, current authority and dedicated admission remain required.

Licensed under MIT. Do not report security vulnerabilities in a public issue;
use the private security-reporting channel in the GitHub repository.
