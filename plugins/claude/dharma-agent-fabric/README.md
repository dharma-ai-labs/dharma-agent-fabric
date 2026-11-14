# Dharma Agent Fabric plugin

**Your agents, learning together.**

Dharma Agent Fabric is the control plane for your organization's agents. This plugin connects Claude Code to your Fabric organization through Dharma's remote MCP server and adds a setup skill for connecting team agents. Grok (preview) can install the same plugin; see [Install](#install).

- **See your organization.** Read your identity and membership for an organization, its logical agents and endpoint bindings, enrolled devices, repository agents, organization instructions, tasks, agent-to-agent handoffs, trajectory capsules and their evidence, the Failure Atlas, remediation campaigns, evaluations, signed skills, learning policies and windows, usage, and control-agent sessions and summaries. Admins can also list workspaces.
- **Run work on your own agents.** With your confirmation, create a logical agent, bind an enrolled local endpoint (Codex or Claude Code) or a managed endpoint (ADK or GCP Vertex BYOK), dispatch a bounded task to a registered endpoint, and hand an active task's state to another endpoint in the same workspace.
- **Evaluate and improve skills.** Run deterministic checks with optional metered analysis and request bounded evidence from a device. Organization admins can take a remediation through staging, backtest, approval, a signed release, a canary rollout, expansion or rollback, merge the exact approved remediation pull request, and configure automatic learning policies with spending caps.
- **Ask the organization control agent.** Open a control-agent session and send it messages. Organization admins approve or reject the paid or state-changing actions it proposes. The first session in an organization provisions a managed runtime on Google Cloud, and each message is a metered model turn.

## What's included

| Component | Purpose |
| --- | --- |
| MCP server `dharma-agent-fabric` | Remote MCP server at `https://mcp.dharma-ai.io/mcp` (streamable HTTP, OAuth) with 65 tools: 28 read-only tools for the organization data listed above; with your confirmation, tools that create agents and bind endpoints, dispatch tasks and agent-to-agent handoffs, request device evidence, run analyses and use the control agent; and admin-only tools for the remediation lifecycle (including merging the approved remediation pull request), skill release and rollout, learning policies and calibration, workspace listing, and control-agent execution. |
| Skill `dharma-agent-fabric-setup` | Guides your agent through connecting an authorized Fabric client: it confirms the actual organization, membership and assigned role, and it keeps installation, enrollment, delivery and observed use as separate, separately verified states. It is guidance, not a one-step installer. Some setup routes still need steps in the Dharma portal. |
| Skill `dharma-agent-fabric` | Operate already-authorized trajectory, task, agent-to-agent, evaluation and signed-skill workflows after setup. Its operational source and nine references are shared with the Codex plugin. |

### Intended skill routing

For onboarding or recovery, prefer `dharma-agent-fabric-setup` to establish the actual client, organization, assigned role and qualified connection.
After setup, use `dharma-agent-fabric` for the admitted operational workflow.
The descriptions overlap on connection-related requests; automatic skill triggers are not guaranteed to be exclusive. This is intended handoff and precedence, not evidence of which skill a client selected or loaded.

### Source parity

The authored operational skill is `plugins/dharma-agent-fabric/skills/dharma-agent-fabric`.
`npm run plugin:skills:generate` renders its ten enumerated files into this plugin;
it does not install anything. The setup skill remains a separate, unchanged tree.
`npm run plugin:skills:generate -- --dry-run` reports the exact proposed paths and
before/after hashes without creating directories or overwriting files.
`npm run plugin:skills:check` checks the complete file set, inline local reference
paths, LF-normalized SHA256 parity and independent route-version increments
against the Git baseline. Raw-byte equality is reported separately. Only these
twenty common-file paths receive the LF Git policy.
Manual publication checks require a nonzero immutable `GITHUB_SHA` matching the
checkout; this validates that selected payload, not its change since a prior release.
PR and push checks retain their separate base/before content-version comparison.

This source candidate is Claude/Grok `1.0.7`; Codex remains `0.1.0`. A later change
to shared content requires each affected route's own version increment, not
synchronized version numbers. A source change does not alter a previously
reviewed or submitted bundle. Publisher review, strict client validation,
installation and publication are separate and are not established by this check.
Static plugin content is not a signed organization skill bundle, activation,
authenticated task use or loaded-context rollback. Neither a file hash nor an
identifier echo proves those states.

## Install

### Claude Code

```
/plugin marketplace add dharma-ai-labs/dharma-agent-fabric
/plugin install dharma-agent-fabric@dharma-ai-labs
```

Then run `/mcp`, select `dharma-agent-fabric` and choose **Authenticate**. Sign in with your Dharma account in the browser and select your organization. The server uses standard MCP OAuth (dynamic client registration with PKCE), so no API key or client secret is needed.

### Grok CLI (Grok Build) (preview, not GA)

```
grok plugin marketplace add dharma-ai-labs/dharma-agent-fabric
grok plugin install dharma-agent-fabric --trust
```

`--trust` activates the plugin's MCP server and skill; omit it to review the source first. Then run `/mcps` in Grok, select `dharma-agent-fabric` and press `i` to authenticate. Sign in with your Dharma account in the browser and select your organization. `grok mcp doctor` reports `Auth required` until you complete this sign-in.

### Grok Bot and grok.com (custom connector) (preview, not GA)

Grok chat surfaces use the remote MCP server directly and carry neither bundled skill (`dharma-agent-fabric-setup` nor `dharma-agent-fabric`) through that connector alone. Do not infer either skill's delivery, activation or use without separately evidenced installation. In Connectors, choose **New Connector** → **Custom**, enter `https://mcp.dharma-ai.io/mcp`, then authenticate with your Dharma account. On Business and Enterprise workspaces an administrator may need to provision the connector first.

### Find your organization ID

Fabric tools take your organization ID (`org_...`) as `organizationId`, and no tool lists the organizations you belong to. Copy the ID from your organization workspace at https://www.dharma-ai.io/portal; it is also part of the organization-specific login command shown in the dashboard (see the [customer guide](https://github.com/dharma-ai-labs/dharma-agent-fabric/blob/main/docs/onboarding/customer-guide.md)). Then ask: "Show my Dharma Agent Fabric identity for organization `org_...`." `fabric_get_identity` confirms your membership state for that organization.

## Try it

Replace `org_...` with your organization ID.

- "Show my Dharma Agent Fabric identity for organization `org_...`."
- "List the agents in Dharma Agent Fabric organization `org_...`."
- "List the enrolled Fabric devices I can see in organization `org_...`."
- "Summarize the recent Fabric tasks in organization `org_...`."
- "List the signed Fabric skills in organization `org_...`."

## Safety and permissions

- Every tool call runs as the signed-in Dharma member. It is limited to that member's active membership and role in the named organization, and the plugin grants no extra permissions.
- Every tool that is not read-only is annotated as such, and tools that can overwrite, remove or roll back state are also annotated destructive. Claude Code asks before it calls an MCP tool unless you have allowed that tool. Dharma's server instructs clients to get your confirmation for sensitive reads and every change.
- The remediation lifecycle (staging, backtest, approval, merge, release, expansion, rollback), skill release, rollout, learning-policy and calibration writes, workspace listing, and control-agent execution and rejection tools are for organization admins only. Control-agent actions that cost money or change state are stored as proposals for an admin to decide.
- No tool runs arbitrary shell commands, reads arbitrary local files, returns secrets or provider credentials, changes roles or membership, merges an arbitrary branch or deploys an environment.
- The setup skill never handles passwords, keys, tokens or grants in chat.

## Data this plugin sends

- **What the plugin itself contains.** The plugin ships no executables, hooks or local telemetry. Its two skills are instructions and references that your agent client reads locally; their presence alone sends nothing, and adding them does not authorize collection, synchronization, dispatch or rollout.
- **Your agent client.** Claude Code (or another client you use) handles your conversation, instructions and tool results under its own configuration and its provider's terms. Nothing here says that this data stays on your device.
- **Sign-in.** Dharma's authorization server (`clerk.dharma-ai.io`) receives the OAuth request, and your client receives an access token for your Dharma account and organization. The server requires the `openid` and `user:org:read` scopes; `profile` and `email` may also be granted.
- **Tool calls.** When your client calls a Fabric tool, the tool name and its arguments (for example an organization, agent, task or remediation ID, a task or message you approved, or an analysis request) go over HTTPS to `https://mcp.dharma-ai.io/mcp`. The response holds only the organization data your membership and role allow.
- **Tools that reach beyond Dharma's own records.** A dispatched task or handoff runs on your organization's own registered endpoint or device. An evidence request is answered by the source device under its own policy, within 25 selectors and 256 KiB. Analysis, learning and the control agent use Google Cloud (Vertex AI Gemini and Dharma's managed runtime). Analysis can open a private remediation pull request in your organization's GitHub repository. An admin-approved merge, release or rollout acts on your organization's GitHub repository, endpoints and runtimes. An admin-approved control-agent managed run, evaluation campaign or analysis runs on Dharma's managed runtime on Google Cloud, or in your organization's own cloud project when it brings its own; a managed-run prompt can be up to 100,000 characters.
- **The Dharma CLI and relay (separate from the connector).** With your approval, the setup skill can guide your agent to install the Dharma CLI from npm (`npm install --global @dharma-ai-labs/agent-fabric`) and sign in at `www.dharma-ai.io`. At enrollment the CLI sends a device name (by default your operating-system user name followed by "device", unless you pass `--device-name`), the operating-system platform and the device's public key. Registering a workspace sends its folder name, default branch, a hashed remote and route, and the provider capabilities it detects. An enrolled device's relay opens outbound connections only. By default it uploads metadata-only trajectory capsules: IDs, provider name, a pseudonymous session ID, event kinds, times, sizes, local analysis counts, hashes and a redaction receipt. It also sends task events and results, evidence responses and skill metadata to Dharma's platform or the configured relay. When a task runs locally, its instructions and supplied context go to the provider client you installed (for example Codex or Claude Code), which uses its own sign-in and network.
- **Uploads your organization's admins can turn on.** If an organization admin enables content disclosure, the relay uploads content-bearing capsules, which can include the provider's own transcript records, automatically, with no confirmation per capsule. The admin sets a retention of 1 to 365 days, and uploads are capped at 1 MiB per capsule and 1 GiB per day. Excluded paths (`.env*`, `.git`, keys, `node_modules`, build output) are removed and secret-like values are rejected. If an owner approves the organization source policy, each repository a member later connects is published as validated snapshots automatically, with no default expiry and a cap of 50,000,000 bytes a day. From repository snapshots, secret-bearing paths, files over 256 KiB and snapshots over 4 MiB are always excluded.
- **Who receives data.** Clerk (sign-in). Google Cloud (Vertex AI Gemini for analysis, learning and the control agent; the managed runtime; and Cloud KMS, which receives the full task, skill and receipt payloads in order to sign them). GitHub (the Dharma GitHub App). Vercel (hosting and request logs). Supabase (database). Stripe (billing). Resend (a new-account notice to Dharma staff). Also the devices, endpoints, repositories and cloud projects your organization chooses.
- **Retention.** Default capsules become tombstones 90 days after upload. Synced content follows the admin's 1-to-365-day setting and is replaced at once if consent is withdrawn. Evidence responses in the 24-hour retention class are removed 24 hours after completion. Learning material expires with its source content. Tasks, agent-to-agent handoffs and control-agent conversations are kept for the life of the organization unless deletion is requested. Billing records are kept for 7 years, audit and idempotency records for 12 months, and hosting logs per provider. See the [privacy policy](https://www.dharma-ai.io/privacy).

## Requirements

- A Dharma AI account with membership in an organization that has Agent Fabric enabled.
- Claude Code with plugin support. The Grok CLI, Grok Bot and grok.com custom connectors are preview, not GA (see [Install](#install)). Other clients that support remote MCP servers with OAuth have not been tested.

## Support and policies

- Website: https://dharma-ai.io/
- Support: https://www.dharma-ai.io/docs/agent-fabric-support
- Privacy policy: https://www.dharma-ai.io/privacy
- Terms of service: https://dharma-ai.io/terms

Developed by Dharma AI Labs, Inc. Licensed under the MIT License.
