# BidStitch Agent Fabric production launch

This guide is the exact customer procedure for connecting BidStitch's production agents to Dharma Agent Fabric. It begins after BidStitch receives its private activation link. It does not require access to Dharma's GCP projects, service accounts, internal runtime URLs, or GitHub App credentials.

BidStitch's production organization is `org_bidstitch`. Use `https://www.dharma-ai.io` for every browser, CLI, and API operation.

## Before the launch call

BidStitch should name:

- the company administrator who will claim the organization;
- one GitHub username that should receive access to the private BidStitch control repository under `dharma-ai-labs`;
- the production source repositories to connect;
- the people who can approve the first remediation release;
- the local providers in use: Codex, Claude Code, Agy, or Hermes Agent;
- the production execution boundary for each service agent: Dharma-managed ADK, GCP Vertex BYOK, or local BYOK;
- the first two production workflows to evaluate. The recommended starting workflows are garment appraisal and a support-to-engineering handoff.

Do not send API keys, model credentials, local paths, raw trajectories, or Git credentials to Dharma in email or chat.

## 1. Claim the paid organization

1. Open the private order link sent to BidStitch's designated billing contact.
2. Sign in with the exact verified email named on the order.
3. Select **Claim organization** and accept the frozen order and legal documents.
4. Open `https://www.dharma-ai.io/portal?orgId=org_bidstitch`.
5. Confirm that the portal shows BidStitch, the USD 1,000 package, and 5,000,000 Dharma credits.

If the private claim link has expired, ask Dharma to reissue it. Do not create a second BidStitch organization and do not reuse a Dharma operator account.

## 2. Accept the control-repository invitation

The portal asks for a GitHub username. Dharma creates or recovers one private control repository under `dharma-ai-labs` and sends that account a collaborator invitation.

The repository contains Dharma policy, Skill, evaluation, release, and receipt artifacts. It does not contain a mirror of BidStitch source code, raw local trajectories, hidden evaluation truth, or credentials.

Accept the invitation, then return to **Agent Fabric > Instructions** in the portal. The page should show:

- organization `org_bidstitch`;
- the control-repository link;
- the current policy revision;
- connected source-repository agents and endpoints;
- copyable commands for the signed-in organization.

## 3. Install Agent Fabric in each selected source repository

Prerequisites are Node.js 22.20 or later, Git, a supported local provider already authenticated, and a browser signed in to BidStitch's Dharma organization.

Install the released CLI:

```bash
npm install --global @dharma-ai-labs/agent-fabric@0.2.20
dharma --version
```

From the root of the first production source repository, run:

```bash
dharma onboard \
  --portal-url https://www.dharma-ai.io \
  --organization-id org_bidstitch \
  --policy-revision agent-fabric-policy-v1 \
  --workspace . \
  --provider codex \
  --provider claude
```

The CLI opens a short-lived browser approval page. Approve the device while signed in to BidStitch. The device receives a sealed Ed25519 identity; no durable API token is placed in the repository or prompt history.

The command then:

1. fingerprints the credential-free Git remote;
2. creates or reuses one logical Dharma agent for that source repository;
3. attaches this machine and each selected provider as endpoints of that agent;
4. assigns the permanent control branch `agents/<repository-slug>-<hash8>`;
5. downloads the approved organization policy;
6. installs `.agents/skills/dharma-agent-fabric/SKILL.md` and supported native provider bootstraps;
7. prints the exact evidence-preview, sync, relay, and Skill-verification commands.

Repeat from each additional selected source repository. The same source repository connected from another machine or provider reuses the logical agent and adds an endpoint; it does not create a duplicate agent.

For a repository without a hosted Git remote, use a stable name agreed by BidStitch:

```bash
dharma repositories connect \
  --repo . \
  --repository-key bidstitch-garment-appraisal-production \
  --organization-id org_bidstitch \
  --policy-revision agent-fabric-policy-v1 \
  --provider codex
```

## 4. Verify each local provider

Run the checks for the provider installed in the current repository:

```bash
dharma status
dharma providers list
dharma skills verify --provider codex --workspace .
dharma skills verify --provider claude --workspace .
```

Use `agy` or `hermes` only when `dharma providers list` reports the required evidence, task, Skill, activation, and rollback capability as available. A provider may support evidence capture without supporting remote task execution.

The verification command must report `ready: true`, `repositoryInstalled: true`, and `nativeInstalled: true`. Start a new provider session after the first installation so it discovers the Skill.

## 5. Preview and synchronize production trajectories

Preview disclosure before the first synchronization:

```bash
dharma evidence preview \
  --workspace . \
  --provider codex \
  --policy .dharma/approved-policy.json \
  --maximum-sessions 20
```

The default `local_analysis` mode keeps prompt and response text, tool arguments and results, source code, and local paths on the device. It sends deterministic failure signals, coverage, event counts, timing, completion state, tool-discipline findings, and evidence-availability metadata. That is sufficient for operational triage and selecting trajectories for deeper review; it is not presented as a semantic judgment.

If BidStitch authorizes content-bearing analysis, an organization administrator must approve the named content classes, redaction, size and daily limits, retention, and secondary-analysis use in the portal. The CLI shows the resulting consent receipt in the preview. Without that durable receipt, content synchronization fails closed.

After reviewing the preview, synchronize a bounded batch:

```bash
dharma evidence capture-batch \
  --workspace . \
  --provider codex \
  --policy .dharma/approved-policy.json \
  --maximum-sessions 20 \
  --sync
```

Start the outbound relay and keep it under the operating system's process manager:

```bash
dharma relay start --policy .dharma/approved-policy.json
```

The relay opens no inbound listener. It accepts only signed, unexpired, organization- and workspace-bound tasks whose path, command, network, Git, budget, lease, and pinned-Skill authority passes local validation.

## 6. Connect BidStitch production service agents

Open **Developer API > Keys** and create a dedicated production key with only the scopes required by the integration. Store it in the service secret manager and display it only once.

Install the TypeScript SDK:

```bash
npm install @dharma-ai-labs/agent-fabric-sdk@0.1.9
```

Set these values in the production service secret store:

```text
DHARMA_API_URL=https://www.dharma-ai.io
DHARMA_ORG_ID=org_bidstitch
DHARMA_ORG_API_TOKEN=<one-time organization token>
DHARMA_AGENT_ID=<managed agent id or slug shown in the portal>
```

Submit a managed garment-appraisal run through Dharma HQ:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AgentFabricClient } from '@dharma-ai-labs/agent-fabric-sdk';

const image = await readFile('./garment-front.jpg');
const client = new AgentFabricClient({
  organizationId: process.env.DHARMA_ORG_ID!,
  token: () => process.env.DHARMA_ORG_API_TOKEN!,
});

const run = await client.submitManagedRun({
  agentId: process.env.DHARMA_AGENT_ID!,
  prompt: 'Estimate a bounded resale range from the supplied image, condition notes, and comparable evidence. State missing evidence and do not invent an exact price.',
  attachments: [{
    displayName: 'garment-front.jpg',
    mimeType: 'image/jpeg',
    dataBase64: image.toString('base64'),
    sha256: `sha256:${createHash('sha256').update(image).digest('hex')}`,
  }],
  metadata: {
    condition: 'visible cuff wear; lining intact',
    comparableSales: [{ currency: 'USD', amount: 220, source: 'bidstitch-comparable-17' }],
  },
});

console.log(run.runId);
```

The SDK submits to Dharma HQ and receives a durable `runId`. BidStitch polls `getManagedRun(runId)` and `getManagedRunEvents(runId)`. The application never calls a private GCP runtime directly.

For GCP Vertex BYOK, BidStitch's cloud administrator applies the exact Workload Identity Federation commands generated by the portal, then selects **Verify**. Do not create or upload a service-account JSON key. Local BYOK keeps model credentials and model execution on the employee device.

## 7. Use the organization control agent

The portal control agent can read BidStitch's connected agents, traces, experiments, failures, remediations, Skills, rollout state, and usage. Mutating or paid operations are proposed for confirmation and use the signed-in user's organization scopes.

From the CLI:

```bash
dharma assistant chat \
  --title "BidStitch production review" \
  --message "List failed garment-appraisal trajectories from the last analysis window and propose the next bounded evaluation. Do not deploy or roll out anything." \
  --confirm

dharma assistant history
```

The control agent can dispatch a structured, task-bound handoff to an online local coding endpoint. The default authority is read-only and no-network. A support agent can request a patch proposal from a coding agent, but it cannot grant itself secret access, merge, deployment, or customer-contact authority.

## 8. What happens after every production interaction

1. Dharma records the run or local evidence capsule with organization, logical-agent, endpoint, policy, and Skill lineage.
2. Deterministic checks run on every completed trajectory.
3. The daily scheduler closes an exact 100-trajectory window. Incomplete windows carry forward.
4. Semantic judging runs only where the organization policy authorizes the required evidence. It versions the rubric, judge prompt, model, confidence threshold, usage, and cost.
5. Related failures become an organization-isolated Failure Atlas family with recurrence, affected agents/endpoints, evidence lineage, and business consequence.
6. Dharma creates one remediation campaign and a child target for every affected logical agent.
7. Each child opens `remediation/<agent-key>/<candidate-id>` against that agent's permanent control branch.
8. Historical replay, at least 20 non-source held-out trajectories, regression checks, security checks, and a canary must pass.
9. BidStitch approves the first organization release in the portal. Later R0-R2 releases may auto-advance after all gates; R3-R4 always require an organization administrator.
10. The signed bundle installs across matching local, managed ADK, and BYOK endpoints. Installation and activation receipts are visible in the portal.
11. Matched cases rerun. Dharma reports measured before/after differences and does not label an unvalidated generated change as an improvement.
12. A failed canary or explicit rollback restores the signed ancestor for the affected agent without changing unrelated agents.

## 9. First production acceptance test

BidStitch and Dharma complete these checks together before routing unrestricted production traffic:

- the BidStitch administrator owns `org_bidstitch` and can access the private control repository;
- each selected source repository maps to one logical agent and permanent control branch;
- each local endpoint reports its real provider capabilities and a valid Skill receipt;
- a garment-appraisal API run completes with a trace and settled usage;
- a support-to-engineering handoff returns a bounded proposal without merge or deploy authority;
- the portal shows trajectories, deterministic findings, semantic findings where evidence was authorized, Failure Atlas, and usage;
- one exact 100-trajectory window completes;
- one remediation PR passes 20 non-source held-out trajectories and the first-release approval;
- the signed bundle reaches the intended endpoints and produces activation receipts;
- a forced rollback affects only the selected logical agent;
- cross-tenant reads and invocations fail closed;
- no browser request goes directly to GCP, a model provider, relay worker, or internal runtime.

Until every item has a live receipt under `org_bidstitch`, BidStitch remains an allowlisted production canary rather than a broad-GA reference tenant.

## 10. Daily operation

- Keep `dharma relay start` supervised on machines that accept remote tasks or Skill delivery.
- Review evidence policy changes before accepting them.
- Use separate API keys for production runs, CI evaluation, and read-only monitoring.
- Inspect failed analysis windows instead of silently retrying indefinitely.
- Review R3/R4 changes and any request that expands evidence, network, Git, deployment, or spending authority.
- Revoke a lost device immediately from the portal.
- Use the usage ledger to reconcile credits by agent, endpoint, run, analysis, and Skill release.
- For offboarding, revoke devices and API keys, stop the relay, remove WIF bindings, disable managed execution, export the contracted audit package, and remove GitHub collaborator access.
