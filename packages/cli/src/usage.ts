export interface CommandUsage {
  /** Command words followed by the options its argument parsing accepts. */
  readonly synopsis: string;
  /** One-line description of what the command does. */
  readonly summary: string;
}

const PROVIDER = '<codex|claude|agy|hermes>';
const ORGANIZATION = '[--organization-id <org>] [--portal-url <origin>]';
const JSON_BODY = '[--json-body <json> | --body-file <file>]';
const DEMO = '--organization-id <org> --repository-id <repo> --normalized-repository <normalized-remote> [--workspace <checkout>] [--knowledge-only] [--portal-url <origin>] [--dry-run]';
const SESSION = '--workspace-id <workspace> [--name <name>]';
const EVALUATION_PACKAGE = '--file <task-package.json> --agent-id <agent> [--name <name>] [--topic-category <category>] [--policy-candidate-id <candidate>] [--continuous-100]';

/** Every command the CLI dispatches, keyed by its command words, in top-level usage order. */
export const COMMAND_USAGE: Readonly<Record<string, CommandUsage>> = Object.freeze({
  'bootstrap': { synopsis: `bootstrap --organization-id <org> --policy-revision <revision> (--grant-prompt | --grant <grant> | --setup-reference <public-reference> --setup-recipient-membership-id <membership> --setup-scope-digest <sha256> --setup-contract-digest <sha256> | --resume) [--portal-url <origin>] [--workspace <checkout>] [--provider <auto|codex|claude|agy|hermes>] [--repository-key <key>] [--complete] [--no-relay-daemon] [--dry-run] [exact source/portal options]`,
    summary: 'Enrolls or resumes this device for one organization and connects the selected checkout.' },
  'setup codex': { synopsis: 'setup codex (--portal-context-sha256 <copied-context-hash> --portal-prompt-sha256 <copied-public-prompt-checksum> | --stdin) --portal-url <origin> --organization-id <org> --setup-reference <public-reference> [--workspace <checkout>] [--maximum-provider-cost-cents <1..25>] [--dry-run]',
    summary: 'Verifies the public portal setup and starts an owned named Codex setup session on Linux.' },
  'onboard': { synopsis: 'onboard --organization-id <org> --policy-revision <revision> [--workspace <checkout>] [--portal-url <origin>] [--provider <provider> | --providers <provider,...>] [--repository-key <key>] [--non-interactive] [--no-relay-daemon]',
    summary: 'Registers the checkout for the enrolled device, first requesting device approval when this DHARMA_HOME is not enrolled.' },
  'login': { synopsis: 'login [--organization-id <org>] [--portal-url <origin>] [--device-name <name>] [--no-browser] [--no-wait] [--resume] [--unattended | --no-unattended] [--reauthenticate] [--dry-run]',
    summary: 'Requests browser approval for this device, or resumes or updates the existing enrolled identity.' },
  'status': { synopsis: 'status [--verbose | --diagnostic]',
    summary: 'Reports enrollment, local relay, supervisor, autostart and reconnect state; --verbose adds local identifiers and per-repository relay state.' },
  'signing-recovery': { synopsis: 'signing-recovery --name <original-name> --workspace-id <workspace> [--apply --operation-id <fresh-public-UUID>] [--json]',
    summary: 'Plans, or with --apply runs, device signing-trust maintenance for a disabled, stopped named session.' },
  'sessions start': { synopsis: `sessions start ${SESSION} [--apply] [--session-budget-cents <1..10000>] [--turn-budget-cents <cents>] [--fence-id <UUID>]`,
    summary: 'Plans, or with --apply starts, the Linux named Codex session for a registered workspace.' },
  'sessions serve': { synopsis: `sessions serve ${SESSION} [--apply] [--session-budget-cents <1..10000>] [--turn-budget-cents <cents>]`,
    summary: 'Plans, or with --apply runs, the owned named-session worker in the foreground; sessions start --apply launches it.' },
  'sessions status': { synopsis: `sessions status ${SESSION}`,
    summary: 'Reports the named session state, or stopped when its service does not answer.' },
  'sessions readiness': { synopsis: `sessions readiness ${SESSION} [--diagnostic]`,
    summary: 'Checks the native readiness receipt of the enabled named session.' },
  'sessions work': { synopsis: `sessions work ${SESSION} --prompt <text> [--work-id <id>]`,
    summary: 'Submits one local work prompt to the running named session.' },
  'sessions stop': { synopsis: `sessions stop ${SESSION} [--drained --fence-id <UUID>] [--apply | --dry-run] [--json]`,
    summary: 'Plans, or with --apply stops and disables, the named session; --drained stops it under a maintenance fence.' },
  'sessions quiesce': { synopsis: `sessions quiesce ${SESSION} --fence-id <UUID> [--apply | --dry-run] [--json]`,
    summary: 'Plans, or with --apply requests, fenced quiescence of the running named session for maintenance.' },
  'sessions resume': { synopsis: `sessions resume ${SESSION} --fence-id <UUID> [--recover-stopped] [--apply | --dry-run] [--json]`,
    summary: 'Plans, or with --apply requests, reopening a quiesced named session under its fence; --recover-stopped permits a verified restart of a stopped one.' },
  'sessions reconcile-stopped-lock': { synopsis: `sessions reconcile-stopped-lock ${SESSION} --registration-sha256 <sha256> --lock-sha256 <sha256> [--apply | --dry-run] [--json]`,
    summary: 'Plans, or with --apply archives, the service lock left by a stopped, disabled named session.' },
  'sessions audit': { synopsis: `sessions audit ${SESSION} --work-id <id>`,
    summary: 'Returns the bounded native audit of one exact work item of the enabled named session.' },
  'demo connect': { synopsis: `demo connect ${DEMO} --grant <grant> [--device-name <name>] [--no-browser]`,
    summary: 'Enrolls this device for a private Demo repository after browser approval.' },
  'demo transport-connect': { synopsis: `demo transport-connect ${DEMO} --transport-origin <https-origin>`,
    summary: 'Connects the enrolled Demo device to one reviewed HTTPS transport origin.' },
  'demo status': { synopsis: `demo status ${DEMO}`,
    summary: 'Reports the Demo device and repository package state.' },
  'demo package': { synopsis: `demo package ${DEMO} [--provider <auto|codex|claude|agy|hermes>]`,
    summary: 'Runs one Demo repository package cycle for the selected provider.' },
  'demo package-status': { synopsis: `demo package-status ${DEMO} [--provider <auto|codex|claude|agy|hermes>]`,
    summary: 'Reports the Demo repository package status.' },
  'demo watch': { synopsis: `demo watch ${DEMO} [--provider <auto|codex|claude|agy|hermes>] [--interval-ms <ms>] [--once]`,
    summary: 'Repeats Demo repository package cycles in the foreground until stopped.' },
  'demo watch-enable': { synopsis: `demo watch-enable ${DEMO} [--provider <auto|codex|claude|agy|hermes>]`,
    summary: 'Registers the Demo repository watch and starts it through relay autostart.' },
  'demo watch-status': { synopsis: `demo watch-status ${DEMO} [--provider <auto|codex|claude|agy|hermes>]`,
    summary: 'Reports the Demo repository watch registration and supervisor state.' },
  'demo watch-disable': { synopsis: `demo watch-disable ${DEMO} [--provider <auto|codex|claude|agy|hermes>]`,
    summary: 'Removes the local Demo repository watch registration.' },
  'demo role': { synopsis: `demo role ${DEMO} --role <role> [--category <category>]...`,
    summary: 'Publishes this device\'s Demo peer role and question categories.' },
  'demo peers': { synopsis: `demo peers ${DEMO}`,
    summary: 'Lists Demo peer devices.' },
  'demo ask': { synopsis: `demo ask ${DEMO} --recipient-device-id <UUID> --content <text>`,
    summary: 'Sends a signed question to one Demo peer device.' },
  'demo reply': { synopsis: `demo reply ${DEMO} --recipient-device-id <UUID> --question-id <UUID> --content <text>`,
    summary: 'Sends a signed reply to one Demo peer question.' },
  'demo inbox': { synopsis: `demo inbox ${DEMO}`,
    summary: 'Lists Demo peer messages for this device.' },
  'demo ack': { synopsis: `demo ack ${DEMO} --message-id <UUID>`,
    summary: 'Acknowledges one Demo peer message.' },
  'demo resume': { synopsis: `demo resume ${DEMO}`,
    summary: 'Completes a pending signed Demo peer request, if one exists.' },
  'demo signing-client-proof': { synopsis: `demo signing-client-proof ${DEMO} --review-context <review.json> [--submit]`,
    summary: 'Prepares, or with --submit submits, the client signing-upgrade proof.' },
  'demo signing-owner-proof': { synopsis: `demo signing-owner-proof ${DEMO} --review-context <review.json>`,
    summary: 'Prepares the owner signing-upgrade proof; owner approval stays in the browser.' },
  'providers list': { synopsis: 'providers list',
    summary: 'Lists the provider adapter capabilities of this device.' },
  'repositories discover': { synopsis: 'repositories discover [<root>...] [--root <root>]...',
    summary: 'Lists Git checkouts at each root and its immediate children.' },
  'repositories connect': { synopsis: `repositories connect [<checkout>...] [--repo <checkout>]... --organization-id <org> --policy-revision <revision> [--repository-key <key> | --repository-key <checkout>=<key>]... [--provider <provider>]...`,
    summary: 'Onboards each selected checkout in turn, stopping when device approval is required.' },
  'repositories list': { synopsis: 'repositories list [--repo <checkout>] [--workspace-id <workspace>] [--verbose | --diagnostic]',
    summary: 'Lists locally registered repositories with their shared-readiness check.' },
  'repositories metadata': { synopsis: 'repositories metadata --repo <owned-checkout> [--workspace-id <workspace>] [--json]',
    summary: 'Reports one local registry record as unverified binding metadata without readiness checks.' },
  'repositories status': { synopsis: 'repositories status [--repo <checkout>] [--workspace-id <workspace>] [--verbose | --diagnostic]',
    summary: 'Lists registered repositories with local relay state and provider capabilities.' },
  'repositories snapshot': { synopsis: 'repositories snapshot --organization-id <org> --workspace-id <workspace> [--workspace <checkout>] [--approved-output <workspace-relative-path>]... [--dry-run | --apply]',
    summary: 'Inventories the local repository package; --apply writes the unsigned local snapshot.' },
  'repositories source-resolve': { synopsis: 'repositories source-resolve --workspace-id <workspace> [--dry-run | --prepare | --apply --plan-hash <sha256> --choose-reviewed-local] [--json]',
    summary: 'Plans, prepares or approves a resolution between local and published repository source.' },
  'repositories restore': { synopsis: 'repositories restore --workspace-id <workspace> (--dry-run | --apply --plan-hash <sha256> [--fence-upload]) [--json]',
    summary: 'Plans or submits a fresh repository restoration candidate after a clear-baseline rollback.' },
  'repositories recover-installer': { synopsis: 'repositories recover-installer --organization-id <org> --workspace-id <current-workspace> --from-workspace-id <old-workspace> [--workspace <checkout>] (--dry-run | --apply)',
    summary: 'Recovers the legacy repository installer for the current canonical binding without a server mutation.' },
  'repositories role-register': { synopsis: 'repositories role-register --workspace-id <workspace> --role-name <name> --role-description <text> --question-categories <category,...> [--expected-revision <revision>]',
    summary: 'Registers role metadata for this repository.' },
  'repositories role-discover': { synopsis: 'repositories role-discover --workspace-id <workspace> [--category <category>]',
    summary: 'Lists repository role metadata, optionally for one question category.' },
  'repositories ask': { synopsis: 'repositories ask --workspace-id <workspace> --category <category> --question <text> [--target-endpoint-id <endpoint> | --session-name <name> --target-session-binding-id <binding> --task-id <task>]',
    summary: 'Asks another repository role a question, directly or through a named session.' },
  'repositories reply': { synopsis: 'repositories reply --workspace-id <workspace> --question-id <question> [--session-name <name> --target-session-binding-id <binding> --task-id <task>]',
    summary: 'Reads the reply to a repository role question.' },
  'workspace add': { synopsis: 'workspace add (<checkout> | --path <checkout>) [--organization-id <org>] [--repository-key <key>] [--name <name>]',
    summary: 'Registers a checkout locally for the enrolled device; its path is not sent to the server.' },
  'workspace sync': { synopsis: `workspace sync (<workspace-id> | --workspace-id <workspace>) --policy-revision <revision> [--provider ${PROVIDER}] [--apply]`,
    summary: 'Plans, or with --apply performs, server registration of a local workspace before repository binding.' },
  'workspace recover-registry': { synopsis: 'workspace recover-registry [--workspace <checkout>] [--dry-run | --apply]',
    summary: 'Plans, or with --apply performs, recovery of the local workspace registry from the owned relay startup anchor.' },
  'evidence preview': { synopsis: `evidence preview --workspace <checkout> --provider ${PROVIDER} [--policy <approved-policy.json>] [--source-root <dir>] [--maximum-sessions <1..1000>] [--maximum-bytes-per-session <bytes>]`,
    summary: 'Summarizes workspace-qualified provider sessions without writing the vault or uploading.' },
  'evidence capture': { synopsis: `evidence capture --workspace <checkout> --provider ${PROVIDER} --policy <approved-policy.json> [--session-ids-file <file>] [--source-root <dir>] [--maximum-bytes-per-session <bytes>] [--output <file>] [--sync]`,
    summary: 'Reduces one workspace-qualified provider session to a trajectory capsule in the encrypted local vault; --sync also uploads it.' },
  'evidence capture-batch': { synopsis: `evidence capture-batch --workspace <checkout> --provider ${PROVIDER} --policy <approved-policy.json> (--maximum-sessions <1..1000> | --session-ids-file <file>) [--source-root <dir>] [--maximum-bytes-per-session <bytes>] [--output <file>] [--sync]`,
    summary: 'Reduces several workspace-qualified provider sessions to trajectory capsules in the encrypted local vault; --sync also uploads them.' },
  'evidence sync': { synopsis: 'evidence sync --file <capsule.json> --policy <approved-policy.json> [--workspace-id <workspace>]',
    summary: 'Uploads one trajectory capsule that exactly matches its encrypted local-vault revision.' },
  'evidence run-request': { synopsis: 'evidence run-request --workspace-id <workspace> --policy <approved-policy.json>',
    summary: 'Processes one pending server evidence request for the workspace.' },
  'relay container-entrypoint': { synopsis: 'relay container-entrypoint [--dry-run | --inspect-startup]',
    summary: 'Runs the owned relay as a non-root Linux container entrypoint; --dry-run prints its plan.' },
  'relay probe': { synopsis: 'relay probe',
    summary: 'Opens one signed relay session for the enrolled device and reports the acknowledgement.' },
  'relay start': { synopsis: 'relay start --policy <approved-policy.json> [--once] [--lease-seconds <seconds>] [--poll-seconds <1..60>]',
    summary: 'Runs the local relay in the foreground for this device\'s registered repositories; --once runs one pass for the given policy.' },
  'relay supervise': { synopsis: 'relay supervise (--policy <approved-policy.json> | --demo-only)',
    summary: 'Supervises relay start, named sessions and Demo watches in the foreground; --demo-only supervises Demo watches only.' },
  'relay stop': { synopsis: 'relay stop',
    summary: 'Stops the local relay supervisor and relay processes after verifying their recorded state.' },
  'relay upgrade': { synopsis: 'relay upgrade [--workspace <checkout>] [--dry-run | --apply] [--rollback | --stage-signing-maintenance [--previous-upgrade-sha256 <sha256>] | --finish-signing-maintenance]',
    summary: 'Plans, or with --apply performs, the owned relay runtime upgrade for the registered checkout.' },
  'relay autostart status': { synopsis: 'relay autostart status',
    summary: 'Reports the owned relay autostart registration.' },
  'relay autostart pause': { synopsis: 'relay autostart pause [--apply | --dry-run] [--json]',
    summary: 'Plans, or with --apply pauses, container-entrypoint autostart while keeping its registration.' },
  'relay autostart disable': { synopsis: 'relay autostart disable',
    summary: 'Disables the owned relay autostart registration.' },
  'assistant chat': { synopsis: 'assistant chat (--message <text> | --json-body <json> | --body-file <file>) --confirm [--session-id <UUID>] [--title <title>]',
    summary: 'Sends a paid organization control-agent message, creating a session unless --session-id is given.' },
  'assistant history': { synopsis: 'assistant history [--session-id <UUID> [--after-sequence <sequence>]]',
    summary: 'Lists control-agent sessions, or the events of one session.' },
  'assistant status': { synopsis: 'assistant status --session-id <UUID>',
    summary: 'Reports one control-agent session and its events.' },
  'assistant approve': { synopsis: 'assistant approve --tool-call-id <UUID> [--session-id <UUID>] [--portal-url <origin>] [--no-open]',
    summary: 'Opens the portal approval page for one tool call; the approval itself happens in the browser.' },
  'assistant reject': { synopsis: 'assistant reject --tool-call-id <UUID> [--session-id <UUID>] [--portal-url <origin>] [--no-open]',
    summary: 'Opens the portal rejection page for one tool call; the rejection itself happens in the browser.' },
  'organization status': { synopsis: `organization status ${ORGANIZATION}`,
    summary: 'Reads the organization instructions from the organization API.' },
  'agents list': { synopsis: `agents list ${ORGANIZATION}`,
    summary: 'Lists organization agents.' },
  'agents bind-runtime': { synopsis: `agents bind-runtime --agent-id <agent> (--json-body <json> | --body-file <file>) --confirm ${ORGANIZATION}`,
    summary: 'Binds a managed_runtime or cloud_byok runtime endpoint to one agent.' },
  'evaluations validate': { synopsis: `evaluations validate ${EVALUATION_PACKAGE} ${ORGANIZATION}`,
    summary: 'Validates a managed evaluation task package and its maximum charge without launching it.' },
  'evaluations launch': { synopsis: `evaluations launch ${EVALUATION_PACKAGE} --confirm ${ORGANIZATION}`,
    summary: 'Validates and launches a paid managed evaluation campaign.' },
  'evaluations status': { synopsis: `evaluations status --campaign-id <campaign> ${ORGANIZATION}`,
    summary: 'Reports one managed evaluation campaign and its sessions.' },
  'evaluations results': { synopsis: `evaluations results --campaign-id <campaign> ${ORGANIZATION}`,
    summary: 'Returns the persisted results of one managed evaluation campaign.' },
  'experiments list': { synopsis: `experiments list ${ORGANIZATION}`,
    summary: 'Lists organization analysis windows.' },
  'experiments run': { synopsis: `experiments run ${JSON_BODY} --confirm ${ORGANIZATION}`,
    summary: 'Requests an organization analysis.' },
  'failures list': { synopsis: `failures list ${ORGANIZATION}`,
    summary: 'Lists organization failures.' },
  'remediations list': { synopsis: `remediations list ${ORGANIZATION}`,
    summary: 'Lists repository remediations.' },
  'remediations act': { synopsis: `remediations act --target-id <target> --action <stage_evaluation|run_backtest|link_backtest|approve|merge_pr|release|expand|rollback> [--endpoint-id <UUID>] ${JSON_BODY} [--dry-run | --confirm] ${ORGANIZATION}`,
    summary: 'Transitions one repository remediation target with --confirm; only stage_evaluation also plans with --dry-run.' },
  'tasks list': { synopsis: `tasks list ${ORGANIZATION}`,
    summary: 'Lists organization tasks.' },
  'tasks dispatch': { synopsis: `tasks dispatch ${JSON_BODY} --confirm ${ORGANIZATION}`,
    summary: 'Dispatches an organization task.' },
  'tasks run-once': { synopsis: 'tasks run-once --policy <approved-policy.json> [--workspace-id <workspace>] [--study-task-id <task-UUID>] [--lease-seconds <seconds>]',
    summary: 'Polls once for a signed task for this device and runs it under the registered workspace\'s verified policy.' },
  'handoffs list': { synopsis: `handoffs list ${ORGANIZATION}`,
    summary: 'Lists A2A handoffs.' },
  'handoffs dispatch': { synopsis: `handoffs dispatch ${JSON_BODY} --confirm ${ORGANIZATION}`,
    summary: 'Dispatches an A2A handoff.' },
  'skills list': { synopsis: `skills list ${ORGANIZATION}`,
    summary: 'Lists organization skills.' },
  'skills release': { synopsis: `skills release ${JSON_BODY} --confirm ${ORGANIZATION}`,
    summary: 'Releases a skill.' },
  'skills rollout': { synopsis: `skills rollout --bundle-id <bundle> [--json-body <json> | --body-file <file>] --confirm ${ORGANIZATION}`,
    summary: 'Starts or expands the rollout of one signed skill bundle.' },
  'skills rollback': { synopsis: `skills rollback --bundle-id <bundle> --confirm ${ORGANIZATION}`,
    summary: 'Rolls back the rollout of one signed skill bundle.' },
  'skills sync': { synopsis: `skills sync --workspace-id <workspace> --provider ${PROVIDER} --policy <approved-policy.json> [--approval-id <evaluation-authorization-id>] [--smoke-command <command-id>] [--dry-run]`,
    summary: 'Installs and activates an available authorized signed skill bundle update; --dry-run checks only the local policy.' },
  'skills status': { synopsis: `skills status --provider ${PROVIDER} --workspace-id <workspace>`,
    summary: 'Reports the active skill bundle and native skill directory of a registered workspace.' },
  'skills verify': { synopsis: `skills verify --provider ${PROVIDER} [--workspace <checkout>]`,
    summary: 'Verifies the native Agent Fabric skill installation and fails when it is not ready.' },
  'usage list': { synopsis: `usage list ${ORGANIZATION}`,
    summary: 'Reads organization usage.' },
});

/** Older spellings that dispatch to a listed command. */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({ capture: 'evidence capture' });

/** Longer notes: each appears in the full usage and in the help of the commands it names. */
const USAGE_NOTES: ReadonlyArray<{ readonly commands: readonly string[]; readonly text: string }> = [
  { commands: [], text: 'Command help: <command> [<subcommand>] --help, or -h, prints only that command\'s usage and exits 0 without running the command or reading device, credential or network state.' },
  { commands: ['setup codex'], text: 'Linux named-Codex setup entry: setup codex --portal-context-sha256 <copied-context-hash> --portal-prompt-sha256 <copied-public-prompt-checksum> --portal-url <origin> --organization-id <org> --setup-reference <public-reference> --workspace <checkout> [--maximum-provider-cost-cents <1..25>] [--dry-run]. Fetches and verifies canonical public portal instructions; this is not attestation of the enclosing human message. Alternatively, legacy --stdin requires the entire original public prompt and cannot combine with either portal hash. No file, secret or human terminal entry. Requires the intended qualified private DHARMA_HOME and existing CODEX_HOME. This starts an owned named setup session with the bound tool; it does not attach to an existing desktop chat. Matching-recipient browser device approval remains required. A refused/expired/interrupted attempt is not retried. Dry-run verifies only public preparation, not execution admission or readiness. The local reservation is conservative unresolved exposure, not an invoice cap.' },
  { commands: ['bootstrap'], text: 'Agent setup compatibility: bootstrap --setup-reference <public-reference> --setup-recipient-membership-id <membership> --setup-scope-digest <sha256> --setup-contract-digest <sha256> --complete [exact source/portal options]. Run inside the coding agent; approve the exact device in the browser. No terminal secret input. --dry-run produces a grant-free plan. Reference setup cannot combine with --grant, --grant-prompt, --resume, replacement, join or disabled relay startup. Legacy private setup: bootstrap --grant-prompt [exact portal options], with USER-only private terminal entry. Enrolled recovery: bootstrap --resume --complete [exact scoped options], with no grant/reference.' },
  { commands: ['login', 'bootstrap'], text: 'Returning device: login --unattended opts in to reuse the approved identity; login --no-unattended disables automatic selection; --dry-run plans either change. login --resume connects once without opting in. login --reauthenticate explicitly requests fresh browser approval for the original protected identity to recover its enrollment anchor; it never replaces keys or configuration. Opted-in bootstrap --complete can omit grants only for the same registered repository and approved policy revision. A compatible membership-guarded server admission response is required. Device admission does not sign in a provider or establish repository readiness. Standing relay lifecycle remains controlled by relay autostart commands.' },
  { commands: ['repositories metadata'], text: 'Repository registration metadata: repositories metadata --repo <owned-checkout> [--workspace-id <workspace>] [--json]. Use only the already permitted original DHARMA_HOME. Requires exactly one local registry record and reports unverified binding metadata with readiness not_checked; no device config, signing key, protected store, network or mutation. It does not verify identity, source policy, native sessions or relay health and cannot run inside a bootstrap callback. Default list/status readiness checks remain unchanged. Never substitute an unknown --metadata-only flag on older list/status commands; unsupported metadata output is not a registry observation.' },
  { commands: ['repositories source-resolve'], text: 'Repository source conflicts: repositories source-resolve --workspace-id <workspace> [--dry-run | --prepare | --apply --plan-hash <sha256> --choose-reviewed-local]. Default is a read-only plan. Review and merge authorized source before preparation; approval is exact-input, expires after 15 minutes and does not publish. Existing relay/evaluation/signing gates remain required.' },
  { commands: ['repositories restore'], text: 'After a clear-baseline rollback: repositories restore --workspace-id <workspace> --dry-run reads a current-policy stable signed catalog and plans a fresh candidate. With the owned relay stopped, --apply --plan-hash <reviewed-hash> submits that exact plan through normal evaluation/signing. It never reactivates an archived release, changes enrollment or resets history. Resume the owned relay only after submission; readiness and activation remain separate checks.' },
  { commands: ['repositories restore'], text: 'For an unresolved restoration upload, an empty lookup is not cancellation. With the owned relay stopped, --apply --plan-hash <original-hash> --fence-upload requests metadata-only fencing under current authority. An admitted operation is returned for ordinary recovery; only a terminal server fence permits checkpoint archival and a new dry-run plan. Fencing does not upload source or activate a release.' },
  { commands: ['sessions readiness'], text: 'Read-only named-session diagnosis: sessions readiness --name <registered-name> --workspace-id <workspace> --diagnostic. Uses the existing owner and unchanged readiness request; never starts a session, runs a model turn or grants access. A closed local failure receipt exits 2 and is not native readiness or permission to retry/restart. No passwords, socket paths or arbitrary remote errors are returned.' },
  { commands: ['evidence capture'], text: 'Assignment-first capture: evidence capture --assignment-id <UUID> [--json] is a selection-only route for independently qualified in-process owner hosts. The exported run API requires the assignment, current binding and exact reader as a separate owner context. The standalone CLI has no default reader and refuses before legacy discovery. No binding file, provider-home fallback, batch, sync, vault, upload, analysis or learning is admitted by this route; ordinary capture without an assignment selector/context is unchanged.' },
  { commands: ['signing-recovery'], text: 'Device signing-trust maintenance: signing-recovery --name <original-name> --workspace-id <workspace> plans without protected-store or network access. --apply --operation-id <fresh-public-UUID> requires the same disabled/stopped original session, protected device and binding, an exclusive device signing-control lease, current source, and fresh recipient plus organization-owner browser consent. The agent controls its existing process with bounded JSONL frames: {"schema":"dharma.device-signing-maintenance-control/v1","operationId":"<same-public-UUID>","action":"progress|complete|status|cancel"}. Use complete only after the exact browser publication receipt. No password, grant, provider login, task, session enable or service restart is accepted. An uncertain action is not automatically retried. Successful trust installation still reports ready:false and nativeContinuationAuthorized:false; ordinary native/task qualification remains separate.' },
  { commands: ['relay upgrade'], text: 'Linux signing-maintenance runtime staging: relay upgrade --workspace <owned-checkout> --stage-signing-maintenance plans an offline upgrade of verified launchers/startup with all owned receivers stopped and the original named session disabled. --apply stages only; it never opens protected storage, starts a receiver or reports a completed upgrade. A prior failed rollback additionally requires --previous-upgrade-sha256 <exact-local-public-journal-hash>, verified restored files/context, and immutable journal archival. Normal signing-recovery remains separately required. After actual trust recovery, relay upgrade --workspace <same-checkout> --finish-signing-maintenance --apply verifies the recovered protected anchor, starts once and requires a fresh current-process poll before completion. Failed or ambiguous finish is retained without automatic retry. No customer terminal input, password, grant or enrollment replacement is part of this maintenance path.' },
];

export const CLI_USAGE = [`Usage: dharma <${Object.keys(COMMAND_USAGE).join('|')}> [options]`,
  ...USAGE_NOTES.map(note => note.text)].join('\n\n');

/** The help tokens the entrypoint honors anywhere in argv: --help, --help=<value> and -h. */
export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some(value => value === '--help' || value === '-h' || value.startsWith('--help='));
}

// Positional words as the dispatcher's option parser reads them: an option consumes the
// next word unless that word starts with `--`. Help switches never take a value.
function commandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '-h') continue;
    if (!value.startsWith('--')) { words.push(value); continue; }
    if (value === '--help' || value.includes('=')) continue;
    const next = argv[index + 1];
    if (next && next !== '-h' && !next.startsWith('--')) index += 1;
  }
  const alias = words[0] !== undefined && Object.hasOwn(COMMAND_ALIASES, words[0]) ? COMMAND_ALIASES[words[0]] : undefined;
  return alias ? [...alias.split(' '), ...words.slice(1)] : words;
}

function entryUsage(key: string, entry: CommandUsage): string {
  return [`Usage: dharma ${entry.synopsis}`, entry.summary,
    ...USAGE_NOTES.filter(note => note.commands.includes(key)).map(note => note.text)].join('\n\n');
}

/**
 * Usage for a help request: the named command's entry, the entries of a named command
 * group, or the full CLI usage for anything else. It only formats text.
 */
export function commandUsage(argv: readonly string[]): string {
  const words = commandWords(argv);
  for (let length = Math.min(words.length, 3); length > 0; length -= 1) {
    const key = words.slice(0, length).join(' ');
    const entry = Object.hasOwn(COMMAND_USAGE, key) ? COMMAND_USAGE[key] : undefined;
    if (entry) return entryUsage(key, entry);
  }
  for (let length = Math.min(words.length, 2); length > 0; length -= 1) {
    const prefix = words.slice(0, length).join(' ');
    const group = Object.entries(COMMAND_USAGE).filter(([key]) => key.startsWith(`${prefix} `));
    if (group.length) {
      return [`Usage: dharma ${prefix} <${group.map(([key]) => key.slice(prefix.length + 1)).join('|')}> [options]`,
        ...group.map(([, entry]) => `${entry.synopsis}\n${entry.summary}`)].join('\n\n');
    }
  }
  return CLI_USAGE;
}
