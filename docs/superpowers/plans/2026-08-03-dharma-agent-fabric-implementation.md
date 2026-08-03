# Dharma Agent Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an open-source local coding-agent relay and the private Dharma services required for adaptive trajectory synchronization, remote task and A2A orchestration, organization-wide evaluation, and signed automatic Skill remediation.

**Architecture:** The local relay retains raw evidence, enforces local policy, and initiates all network connections. The Dharma control plane stores reduced organization-scoped evidence, dispatches signed tasks, evaluates trajectories, manages customer Skill repositories, and releases immutable bundles. Better Harness provider adapters are preserved behind Dharma interfaces rather than rewritten.

**Tech Stack:** Node.js 22, TypeScript, npm workspaces, JSON Schema 2020-12, SQLite, PostgreSQL, Redis/BullMQ for v1 eventing, WebSocket and HTTPS, GCS or S3-compatible object storage, Ed25519 signatures, GitHub App, Fastify, OpenAI-compatible and provider-specific model gateways, MCP and OpenAI Apps SDK.

## Global Constraints

- Node.js must remain `>=22.20.0 <25.0.0` while the Better Harness upstream dependency keeps that range.
- All local network connections are outbound initiated.
- Raw provider evidence remains in an encrypted local vault.
- Pilot default evidence mode is `reduced_full_session` after secret filtering and evidence reduction.
- Every server instruction is a signed typed envelope with expiry and replay protection.
- Default task authority permits a task branch but never default-branch merge or deployment.
- Installed Skills come only from immutable signed bundles pinned to exact commits and hashes.
- Low-risk Skill installation is automatic; high-risk authority changes require explicit approval.
- JSON Schemas are canonical protocol contracts.
- Machine output on stdout is parser-safe.
- Better Harness-derived code retains the Qoder MIT notice.
- Do not call the first implementation an integrity-contract compiler.
- Each task ends with independently testable software and a commit.

---

## Target File Structure

```text
dharma-agent-fabric/
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── AGENTS.md
├── THIRD_PARTY_NOTICES.md
├── schemas/
├── upstream/better-harness/
├── packages/
│   ├── contracts/
│   ├── policy/
│   ├── local-vault/
│   ├── evidence-reduction/
│   ├── provider-adapters/
│   ├── relay-protocol/
│   ├── task-runner/
│   ├── a2a-client/
│   ├── skill-manager/
│   └── cli/
├── apps/relay-daemon/
├── plugins/codex/
├── fixtures/
├── test/
└── docs/
```

The private control-plane implementation may live in the existing Cognitive Integrity repository, but it must consume the released contracts package from this public repository.

---

### Task 1: Bootstrap the public monorepo and upstream boundary

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `LICENSES/Qoder-Better-Harness-MIT.txt`
- Create: `scripts/verify-upstream-boundary.mjs`
- Create: `test/upstream-boundary.test.mjs`
- Import: `upstream/better-harness/**`

**Interfaces:**
- Produces npm workspace roots and the stable `upstream/better-harness` boundary.
- Produces `npm run upstream:verify` for later tasks.

- [ ] **Step 1: Write the failing upstream-boundary test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Better Harness attribution and isolated source boundary exist", async () => {
  const notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  const license = await readFile("LICENSES/Qoder-Better-Harness-MIT.txt", "utf8");
  const packageJson = JSON.parse(await readFile("upstream/better-harness/package.json", "utf8"));
  assert.match(notice, /QoderAI\/better-harness/);
  assert.match(license, /MIT License/);
  assert.equal(packageJson.name, "@qoderai/better-harness");
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/upstream-boundary.test.mjs`  
Expected: FAIL because the files and upstream source do not exist.

- [ ] **Step 3: Create the workspace and import the pinned upstream source**

Use a fork or subtree that preserves history. Set root scripts:

```json
{
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "engines": {"node": ">=22.20.0 <25.0.0"},
  "scripts": {
    "test": "node --test",
    "upstream:verify": "node scripts/verify-upstream-boundary.mjs"
  }
}
```

- [ ] **Step 4: Add the exact Qoder MIT text and attribution**

`THIRD_PARTY_NOTICES.md` must identify the upstream repository, pinned commit, local path, license, and intentional Dharma adapter boundary.

- [ ] **Step 5: Run tests**

Run: `npm test && npm run upstream:verify`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore THIRD_PARTY_NOTICES.md LICENSES scripts test upstream
git commit -m "chore: establish agent fabric monorepo and upstream boundary"
```

---

### Task 2: Install canonical schemas and contract validation

**Files:**
- Create: `schemas/*.schema.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/schema-registry.ts`
- Create: `packages/contracts/src/types.ts`
- Create: `packages/contracts/src/canonical-json.ts`
- Create: `packages/contracts/src/signing.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `scripts/validate-schemas.mjs`

**Interfaces:**
- Produces `validateContract(schemaId, value): ValidationResult`.
- Produces `canonicalEnvelopeBytes(value): Uint8Array`.
- Produces contract types used by every local and server module.

- [ ] **Step 1: Copy the package schemas into the target `schemas/` directory**

Use the exact schemas supplied in this build package. Do not alter field meaning during bootstrap.

- [ ] **Step 2: Write failing schema registry tests**

```ts
import { describe, it, expect } from "vitest";
import { validateContract } from "../src/schema-registry.js";
import task from "../../../examples/task-envelope.json" with { type: "json" };

describe("contract registry", () => {
  it("accepts the supplied TaskEnvelope example", () => {
    expect(validateContract("dharma.task/v1", task)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an envelope without organizationId", () => {
    const invalid = { ...task } as Record<string, unknown>;
    delete invalid.organizationId;
    expect(validateContract("dharma.task/v1", invalid).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test --workspace @dharma-ai/agent-fabric-contracts`  
Expected: FAIL because the registry is absent.

- [ ] **Step 4: Implement schema loading and strict validation**

Use Ajv 2020 with formats. Reject unknown schema IDs and return stable error paths.

- [ ] **Step 5: Implement canonical JSON and Ed25519 helpers**

Canonicalization must sort object keys recursively, preserve array order, exclude the `signature` field from signed content, encode UTF-8, and have golden fixture tests.

- [ ] **Step 6: Run schema and contract tests**

Run: `npm run schema:validate && npm test --workspace @dharma-ai/agent-fabric-contracts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add schemas packages/contracts scripts/validate-schemas.mjs examples
git commit -m "feat(protocol): add canonical agent fabric contracts"
```

---

### Task 3: Implement organization policy parsing and local narrowing

**Files:**
- Create: `packages/policy/package.json`
- Create: `packages/policy/src/policy.ts`
- Create: `packages/policy/src/path-policy.ts`
- Create: `packages/policy/src/command-policy.ts`
- Create: `packages/policy/src/evidence-policy.ts`
- Create: `packages/policy/src/task-policy.ts`
- Create: `packages/policy/test/policy.test.ts`
- Create: `examples/organization-policy.yaml`

**Interfaces:**
- Produces `loadOrganizationPolicy(path): OrganizationPolicy`.
- Produces `evaluateEvidence`, `evaluateTask`, `evaluatePath`, and `evaluateCommand` decisions with receipts.
- Local override can narrow but cannot broaden organization policy.

- [ ] **Step 1: Write tests for narrowing and deny behavior**

```ts
it("local policy cannot broaden an organization denied path", () => {
  const decision = mergePolicies(orgPolicy, localPolicyAllowingEnv);
  expect(evaluatePath(decision, "<workspace>/.env", "read").allow).toBe(false);
});

it("reduced_full_session is accepted for registered pilot workspaces", () => {
  expect(evaluateEvidence(orgPolicy, registeredWorkspace).mode).toBe("reduced_full_session");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @dharma-ai/agent-fabric-policy`  
Expected: FAIL.

- [ ] **Step 3: Implement typed YAML loading and validation**

Validate against an internal policy schema. Reject ambiguous glob patterns, absolute external paths, unregistered commands, and unknown evidence modes.

- [ ] **Step 4: Implement policy decision receipts**

Every decision returns `{ allow, reasonCode, policyRevision, matchedRuleIds }` without exposing secret values.

- [ ] **Step 5: Run tests**

Run: `npm test --workspace @dharma-ai/agent-fabric-policy`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/policy examples/organization-policy.yaml
git commit -m "feat(policy): enforce local evidence and task boundaries"
```

---

### Task 4: Build the encrypted local evidence vault

**Files:**
- Create: `packages/local-vault/package.json`
- Create: `packages/local-vault/src/key-provider.ts`
- Create: `packages/local-vault/src/blob-store.ts`
- Create: `packages/local-vault/src/database.ts`
- Create: `packages/local-vault/src/vault.ts`
- Create: `packages/local-vault/src/retention.ts`
- Create: `packages/local-vault/test/vault.test.ts`
- Create: `packages/local-vault/test/fixtures.ts`

**Interfaces:**
- Produces `LocalVault.open(options): Promise<LocalVault>`.
- Produces `putEvidence`, `getEvidence`, `recordDisclosure`, `enqueueCapsule`, and `acknowledgeUpload`.

- [ ] **Step 1: Write failing encryption and restart tests**

```ts
it("stores no plaintext secret in the blob file", async () => {
  const vault = await fixtureVault();
  const result = await vault.putEvidence(Buffer.from("token=sk-fixture-secret"), metadata);
  const disk = await readFile(result.diskPath);
  expect(disk.includes(Buffer.from("sk-fixture-secret"))).toBe(false);
  expect((await vault.getEvidence(result.contentId)).toString()).toContain("sk-fixture-secret");
});

it("recovers queued capsules after restart", async () => {
  const first = await fixtureVault();
  await first.enqueueCapsule(capsule);
  await first.close();
  const second = await reopenFixtureVault();
  expect(await second.listPendingCapsules()).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @dharma-ai/agent-fabric-local-vault`  
Expected: FAIL.

- [ ] **Step 3: Implement key-provider abstraction**

Production providers use OS keychain integrations. Tests use an in-memory key provider. Never persist the plaintext master key in the vault directory.

- [ ] **Step 4: Implement content-addressed encrypted blobs and SQLite metadata**

Use atomic temporary files, authenticated encryption, content hash verification, and database transactions.

- [ ] **Step 5: Implement retention and disclosure receipts**

Retention must distinguish raw local evidence, spool, and receipts. Deleting a blob referenced by a pending disclosure or task must fail.

- [ ] **Step 6: Run tests**

Run: `npm test --workspace @dharma-ai/agent-fabric-local-vault`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/local-vault
git commit -m "feat(vault): add encrypted local evidence storage"
```

---

### Task 5: Implement secret filtering and evidence reduction

**Files:**
- Create: `packages/evidence-reduction/package.json`
- Create: `packages/evidence-reduction/src/secret-detectors.ts`
- Create: `packages/evidence-reduction/src/redactor.ts`
- Create: `packages/evidence-reduction/src/normalizer.ts`
- Create: `packages/evidence-reduction/src/deduplicator.ts`
- Create: `packages/evidence-reduction/src/output-collapser.ts`
- Create: `packages/evidence-reduction/src/selector.ts`
- Create: `packages/evidence-reduction/src/capsule-builder.ts`
- Create: `packages/evidence-reduction/test/reduction.test.ts`
- Create: `fixtures/secrets/**`

**Interfaces:**
- Produces `reduceTrajectory(input, policy): Promise<ReducedTrajectory>`.
- Produces a schema-valid `TrajectoryCapsule` and local content index.

- [ ] **Step 1: Write failing secret and dedupe tests**

```ts
it("removes fixture credentials from every serialized output", async () => {
  const result = await reduceTrajectory(fixtureTrajectoryWithSecrets, policy);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("sk-fixture-secret");
  expect(result.redactionReceipt.classes).toContain("openai_api_key");
});

it("stores one code span and references it from repeated events", async () => {
  const result = await reduceTrajectory(repeatedCodeTrajectory, policy);
  expect(result.contentIndex.filter(x => x.kind === "code_span")).toHaveLength(1);
  expect(result.events.filter(x => x.contentRef)).toHaveLength(3);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @dharma-ai/agent-fabric-evidence-reduction`  
Expected: FAIL.

- [ ] **Step 3: Implement mandatory detectors**

Cover private keys, common API tokens, bearer tokens, connection strings, `.env` assignments, cookies, and organization patterns. Record only detector class and replacement ID.

- [ ] **Step 4: Implement normalization, collapse, and selection**

Preserve meaningful messages, failures, retries, diffs, validation, permissions, and Skill state. Collapse repeated output with first sample, last sample, count, and local content reference.

- [ ] **Step 5: Build the revisioned capsule**

Include previous revision hash, coverage, omissions, redaction receipt, and local evidence availability.

- [ ] **Step 6: Validate the capsule schema in tests**

Run: `npm run schema:validate && npm test --workspace @dharma-ai/agent-fabric-evidence-reduction`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence-reduction fixtures/secrets
git commit -m "feat(evidence): add adaptive deep trajectory reduction"
```

---

### Task 6: Bridge Better Harness provider evidence into Dharma contracts

**Files:**
- Create: `packages/provider-adapters/package.json`
- Create: `packages/provider-adapters/src/interfaces.ts`
- Create: `packages/provider-adapters/src/registry.ts`
- Create: `packages/provider-adapters/src/better-harness-bridge.ts`
- Create: `packages/provider-adapters/src/capability-report.ts`
- Create: `packages/provider-adapters/test/bridge.test.ts`

**Interfaces:**
- Produces `getEvidenceAdapter(providerId)`.
- Produces `probeProviderCapabilities(workspace, providerId)`.
- Consumes only Better Harness public CLI or public module surfaces.

- [ ] **Step 1: Write a failing bridge test using a frozen Better Harness fixture**

The test must verify that session, project, and configured-asset lanes remain distinct and that unavailable lanes remain unavailable.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @dharma-ai/agent-fabric-provider-adapters`  
Expected: FAIL.

- [ ] **Step 3: Implement the public bridge**

Call the Better Harness evidence-bundle capability with exact provider, workspace, window, depth, and scope. Do not import capability-private helpers.

- [ ] **Step 4: Map provider evidence to Dharma `AgentEvent` without losing source coverage**

Preserve original provider event identity, coverage state, and local source references.

- [ ] **Step 5: Run upstream and bridge tests**

Run: `npm run upstream:verify && npm test --workspace @dharma-ai/agent-fabric-provider-adapters`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-adapters
git commit -m "feat(adapters): bridge better harness evidence providers"
```

---

### Task 7: Deliver Codex and Claude evidence adapters

**Files:**
- Create: `packages/provider-adapters/src/providers/codex.ts`
- Create: `packages/provider-adapters/src/providers/claude.ts`
- Create: `packages/provider-adapters/test/codex.test.ts`
- Create: `packages/provider-adapters/test/claude.test.ts`
- Create: `fixtures/providers/codex/**`
- Create: `fixtures/providers/claude/**`

**Interfaces:**
- Registers `codex` and `claude` evidence and configured-asset capabilities.
- Produces normalized event streams and exact evidence limitations.

- [ ] **Step 1: Add positive and foreign-workspace fixtures**

Include Windows and POSIX paths, missing usage fields, unknown events, failed tool calls, and fixture secrets.

- [ ] **Step 2: Write failing admission tests**

```ts
it("rejects Codex sessions bound to another workspace", async () => {
  const sessions = await codex.collectSessions(requestedWorkspace);
  expect(sessions.admitted.map(x => x.id)).not.toContain("foreign-session");
});
```

- [ ] **Step 3: Implement provider wrappers and capability reports**

Honor provider home overrides. An empty override must not fall back to the default home.

- [ ] **Step 4: Run fixture tests**

Run: `npm test --workspace @dharma-ai/agent-fabric-provider-adapters`  
Expected: PASS.

- [ ] **Step 5: Run bounded native smokes**

Record installed host versions, source counts, admitted sessions, and unavailable fields. Do not commit raw native transcripts.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-adapters fixtures/providers
git commit -m "feat(adapters): support codex and claude trajectory evidence"
```

---

### Task 8: Implement the local capture CLI vertical slice

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/capture.ts`
- Create: `packages/cli/src/commands/evidence-preview.ts`
- Create: `packages/cli/src/output.ts`
- Create: `packages/cli/test/capture.e2e.test.ts`
- Create: `apps/relay-daemon/package.json`
- Create: `apps/relay-daemon/src/main.ts`

**Interfaces:**
- Produces `dharma capture` and `dharma evidence preview`.
- The capture command performs no network operation.

- [ ] **Step 1: Write the failing end-to-end capture test**

Invoke the built CLI against a fixture workspace and assert:

- exit code 0;
- stdout is one JSON document;
- capsule validates;
- no fixture secret;
- foreign session absent;
- raw evidence exists encrypted in fixture vault;
- evidence coverage is explicit.

- [ ] **Step 2: Implement parser-safe CLI dispatch**

Human output may be readable, but `--json` writes only JSON to stdout and diagnostics to stderr.

- [ ] **Step 3: Wire policy, adapters, vault, and reduction**

The command sequence is deterministic and writes the capsule only after validation passes.

- [ ] **Step 4: Run the Phase 1 gate**

Run:

```bash
npm run test
npm run schema:validate
npm run upstream:verify
node packages/cli/dist/index.js capture --provider codex --workspace fixtures/workspaces/sample --policy examples/organization-policy.yaml --output .tmp/capsule.json --json
```

Expected: all commands pass and the final capsule validates.

- [ ] **Step 5: Commit**

```bash
git add packages/cli apps/relay-daemon
git commit -m "feat(cli): capture workspace trajectories into local capsules"
```

**Phase 1 review gate:** Stop here for independent review before implementing network or remote mutation.

---

### Task 9: Add device identity and enrollment

**Files:**
- Create: `packages/relay-protocol/package.json`
- Create: `packages/relay-protocol/src/device-key.ts`
- Create: `packages/relay-protocol/src/enrollment.ts`
- Create: `packages/relay-protocol/src/envelope.ts`
- Create: `packages/relay-protocol/test/enrollment.test.ts`
- Create: `packages/cli/src/commands/login.ts`
- Create: `packages/cli/src/commands/device-status.ts`

**Interfaces:**
- Produces `DeviceKeyProvider`, `beginEnrollment`, `completeEnrollment`, `signEnvelope`, and `verifyEnvelope`.
- Stores private keys only through a key-provider abstraction.

- [ ] **Step 1: Write failing device-signature tests**

```ts
it("signs and verifies a canonical envelope", async () => {
  const key = await testKeyProvider.create();
  const signed = await signEnvelope(unsignedEnvelope, key);
  expect(await verifyEnvelope(signed, key.publicKey)).toBe(true);
});

it("rejects payload mutation", async () => {
  const signed = await signedFixture();
  signed.payload.workspaceId = "other";
  expect(await verifyEnvelope(signed, publicKey)).toBe(false);
});
```

- [ ] **Step 2: Implement Ed25519 key creation and canonical signing**

Production key providers target Windows Credential Manager, macOS Keychain, and Linux Secret Service. Land the interface and test provider first, then one production implementation per platform behind feature detection.

- [ ] **Step 3: Implement OAuth device authorization client**

The CLI displays the verification URL and user code, polls within the server interval, and stores only the returned device session material.

- [ ] **Step 4: Add revocation and key rotation state**

A revoked key cannot sign new envelopes. Rotation preserves old public keys only for receipt verification.

- [ ] **Step 5: Run tests and commit**

```bash
npm test --workspace @dharma-ai/agent-fabric-relay-protocol
git add packages/relay-protocol packages/cli
git commit -m "feat(identity): add device enrollment and signed envelopes"
```

---

### Task 10: Implement the outbound relay connection and durable cursors

**Files:**
- Create: `packages/relay-protocol/src/websocket-session.ts`
- Create: `packages/relay-protocol/src/replay-cache.ts`
- Create: `packages/relay-protocol/src/cursor-store.ts`
- Create: `packages/relay-protocol/src/http-upload.ts`
- Create: `packages/relay-protocol/test/session.test.ts`
- Modify: `apps/relay-daemon/src/main.ts`
- Create: `apps/relay-daemon/src/supervisor.ts`

**Interfaces:**
- Produces `RelaySession.connect(config): Promise<RelaySession>`.
- Produces `send`, `subscribe`, `close`, and resumable upload APIs.

- [ ] **Step 1: Write protocol tests for handshake, expiry, replay, and reconnect**

Use an in-process fake server. Assert that duplicate message IDs and expired tasks are rejected before handler dispatch.

- [ ] **Step 2: Implement handshake and heartbeats**

Bind session ID, device ID, schema versions, sequence, and policy revision.

- [ ] **Step 3: Implement durable outbound spool and cursor acknowledgements**

A server acknowledgement removes only the exact committed operation. Process restart must resume without duplicate effect.

- [ ] **Step 4: Implement bulk upload manifest and hash verification**

The relay requests scoped URLs, uploads encrypted compressed chunks, and finalizes with hashes.

- [ ] **Step 5: Run disconnect and reconnect tests**

Run: `npm test --workspace @dharma-ai/agent-fabric-relay-protocol`  
Expected: PASS with no duplicate accepted capsule.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-protocol apps/relay-daemon
git commit -m "feat(relay): add outbound session and resumable delivery"
```

---

### Task 11: Build server device registry and trajectory ingestion

**Files in private control plane:**
- Create: `apps/relay-gateway/src/server.ts`
- Create: `apps/relay-gateway/src/handshake.ts`
- Create: `services/device-registry/src/device-service.ts`
- Create: `services/trajectory-ingest/src/manifest-service.ts`
- Create: `services/trajectory-ingest/src/chunk-service.ts`
- Create: `packages/persistence/src/agent-fabric-repositories.ts`
- Create: `migrations/<timestamp>_agent_fabric_foundation.sql`
- Create: `test/agent-fabric/ingest.e2e.test.ts`

**Interfaces:**
- Consumes released public contracts package.
- Produces authenticated relay sessions and `acceptTrajectoryManifest`.

- [ ] **Step 1: Write migration and tenant-isolation tests**

Test that an organization-bound repository cannot read or update another organization's device or trajectory.

- [ ] **Step 2: Implement migrations for organizations, devices, workspaces, trajectories, and revisions**

Use existing organization identity. Do not create a second user-role authority.

- [ ] **Step 3: Implement gateway handshake and session presence**

Validate device key, status, organization, clock skew, replay cache, and supported schemas.

- [ ] **Step 4: Implement manifest intake and scoped object upload**

Reject oversized, invalid, revoked, wrong-workspace, or hash-conflicting manifests.

- [ ] **Step 5: Implement atomic ingestion completion**

A trajectory revision becomes visible only after every chunk hash verifies.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- agent-fabric/ingest.e2e.test.ts
git add apps/relay-gateway services/device-registry services/trajectory-ingest packages/persistence migrations test
git commit -m "feat(ingest): accept organization-scoped trajectory capsules"
```

---

### Task 12: Implement server-requested evidence expansion

**Files:**
- Public: `packages/relay-protocol/src/evidence-request-handler.ts`
- Public: `packages/relay-protocol/test/evidence-request.test.ts`
- Private: `services/evidence-request/src/evidence-request-service.ts`
- Private: `services/evidence-request/src/disclosure-service.ts`
- Private: `test/agent-fabric/evidence-expansion.e2e.test.ts`

**Interfaces:**
- Produces `EvidenceRequest` creation, local authorization, `EvidenceResponse`, and disclosure receipt.

- [ ] **Step 1: Write local tests for exact advertised content refs**

Reject a request for an unadvertised external path. Accept an exact local content ID when purpose, byte cap, retention, and policy allow it.

- [ ] **Step 2: Implement server request authorization**

The server requires a named purpose, actor capability, trajectory, selector, byte cap, retention class, and expiry.

- [ ] **Step 3: Implement relay re-filtering and response manifest**

Every expanded span passes secret filtering again. Missing local content is returned as `unavailable`.

- [ ] **Step 4: Persist local and server disclosure receipts**

Receipts contain hashes and redaction summary, not secret content.

- [ ] **Step 5: Run end-to-end test and commit**

```bash
npm test -- evidence-expansion.e2e.test.ts
git add packages/relay-protocol services/evidence-request test
git commit -m "feat(evidence): add policy-bound evidence expansion"
```

---

### Task 13: Implement the local task runner and worktree authority

**Files:**
- Create: `packages/task-runner/package.json`
- Create: `packages/task-runner/src/task-state.ts`
- Create: `packages/task-runner/src/worktree.ts`
- Create: `packages/task-runner/src/command-runner.ts`
- Create: `packages/task-runner/src/path-guard.ts`
- Create: `packages/task-runner/src/task-executor.ts`
- Create: `packages/task-runner/test/task-runner.test.ts`
- Create: `fixtures/repositories/task-runner/**`

**Interfaces:**
- Produces `TaskExecutor.offer(envelope)`, `start`, `sendMessage`, `cancel`, and `collectFinal`.

- [ ] **Step 1: Write failing path escape and default-branch tests**

```ts
it("rejects writes outside the worktree", async () => {
  const result = await executor.applyWrite("../outside.txt", "x");
  expect(result.code).toBe("TASK_PATH_DENIED");
});

it("never merges the task branch under default authority", async () => {
  await executor.complete(task);
  expect(await git.currentBranch(mainWorkspace)).toBe("main");
  expect(await git.branchExists(`dharma/task/${task.id}`)).toBe(true);
});
```

- [ ] **Step 2: Implement task state and lease validation**

A task cannot start after expiry or continue mutation after lease expiry.

- [ ] **Step 3: Implement worktree creation and containment**

Canonicalize paths and reject symlink escape. Store task worktrees below the relay task directory.

- [ ] **Step 4: Implement argv-array command registry**

No shell-string dispatch. Enforce timeout, environment allowlist, output limits, and network mode.

- [ ] **Step 5: Implement final Git evidence and task branch push**

Record base commit, final commit, diff hash, remote, and acceptance results.

- [ ] **Step 6: Run tests and commit**

```bash
npm test --workspace @dharma-ai/agent-fabric-task-runner
git add packages/task-runner fixtures/repositories
git commit -m "feat(tasks): execute bounded work in isolated worktrees"
```

---

### Task 14: Add Codex and Claude task adapters

**Files:**
- Create: `packages/provider-adapters/src/task/codex-task.ts`
- Create: `packages/provider-adapters/src/task/claude-task.ts`
- Create: `packages/provider-adapters/src/task/process-events.ts`
- Create: `packages/provider-adapters/test/codex-task.test.ts`
- Create: `packages/provider-adapters/test/claude-task.test.ts`

**Interfaces:**
- Implements `ProviderTaskAdapter` for Codex and Claude.
- Emits normalized runtime events without raw unbounded stdout.

- [ ] **Step 1: Record exact native CLI contracts from pinned installed versions**

Capture `--help`, version, non-interactive invocation, cancellation behavior, and session continuation support in test fixtures. Do not guess commands.

- [ ] **Step 2: Write failing fake-process adapter tests**

Cover start, messages, cancellation, failure, and final collection.

- [ ] **Step 3: Implement process launch and event normalization**

Use argv arrays, controlled environment, worktree cwd, and provider-native authentication.

- [ ] **Step 4: Add bounded native smoke tests**

Run one no-op or fixture task with each installed provider. Preserve only sanitized evidence.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-adapters
git commit -m "feat(adapters): run bounded codex and claude tasks"
```

---

### Task 15: Implement server task broker and organization orchestrator

**Files:**
- Private: `services/task-broker/src/task-service.ts`
- Private: `services/task-broker/src/lease-service.ts`
- Private: `services/orchestrator/src/worker-selector.ts`
- Private: `services/orchestrator/src/orchestrator.ts`
- Private: `apps/organization-api/src/routes/agent-fabric-tasks.ts`
- Private: `test/agent-fabric/task-dispatch.e2e.test.ts`

**Interfaces:**
- Produces `createTask`, `selectWorker`, `offerTask`, `renewLease`, `cancelTask`, and `completeTask`.

- [ ] **Step 1: Write worker selection tests**

Select only online devices with the exact workspace, provider capability, Skill bundle compatibility, available concurrency, and budget.

- [ ] **Step 2: Implement persistent task state and leases**

Use a transactional outbox for dispatch. Redis may accelerate routing but cannot be the sole task record.

- [ ] **Step 3: Implement signed exact-device offers**

The final envelope names one device. Local rejection records a stable reason.

- [ ] **Step 4: Implement completion and artifact intake**

Verify final commit, task branch, acceptance results, capsule IDs, and hashes.

- [ ] **Step 5: Run local task end-to-end**

Server -> relay -> Codex fixture task -> test -> task branch -> server result.

- [ ] **Step 6: Commit**

```bash
git add services/task-broker services/orchestrator apps/organization-api test
git commit -m "feat(orchestrator): dispatch tasks to compatible local agents"
```

---

### Task 16: Implement A2A conversations across local and managed agents

**Files:**
- Public: `packages/a2a-client/package.json`
- Public: `packages/a2a-client/src/client.ts`
- Public: `packages/a2a-client/src/offline-queue.ts`
- Public: `packages/a2a-client/test/client.test.ts`
- Private: `services/a2a-broker/src/conversation-service.ts`
- Private: `services/a2a-broker/src/router.ts`
- Private: `apps/organization-api/src/routes/agent-fabric-conversations.ts`
- Private: `test/agent-fabric/a2a.e2e.test.ts`

**Interfaces:**
- Produces conversation creation, message delivery, structured state, acknowledgements, and replies.

- [ ] **Step 1: Write message lineage and expiry tests**

Verify parent message, conversation, task, evidence references, and structured authority survive routing.

- [ ] **Step 2: Implement local offline queue**

The client accepts only messages for registered workspaces and supported agents.

- [ ] **Step 3: Implement server routing**

Support specific target, capability selector, workspace queue, managed worker, and human approval target.

- [ ] **Step 4: Implement managed-to-local and local-to-managed e2e test**

Use the same schema in both directions and verify delivery plus application acknowledgement.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-client services/a2a-broker apps/organization-api test
git commit -m "feat(a2a): connect local and managed organization agents"
```

---

### Task 17: Provision customer skill control repositories through the GitHub App

**Files:**
- Private: `services/github-app/src/customer-control-repo.ts`
- Private: `services/github-app/src/skill-branch.ts`
- Private: `services/github-app/src/remediation-pr.ts`
- Private: `services/github-app/test/customer-control-repo.test.ts`
- Private: `apps/organization-api/src/routes/agent-fabric-skills.ts`

**Interfaces:**
- Produces `ensureCustomerControlRepository`, `ensureSkillBranch`, and `createRemediationPullRequest`.

- [ ] **Step 1: Write tests against a fake GitHub client**

Verify repository naming, branch isolation, idempotent provisioning, source commit identity, and no access outside the configured customer repository.

- [ ] **Step 2: Implement repository provisioning**

Create private repository, branch protection, CODEOWNERS, required checks, Skill templates, and export metadata.

- [ ] **Step 3: Implement one authoring branch per Skill**

Branch names use `skill/<stable-id>`. The service refuses to install or release a branch head directly.

- [ ] **Step 4: Implement remediation pull request creation**

Include failure family, evidence boundary, risk class, validation plan, and rollback condition.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- customer-control-repo.test.ts
git add services/github-app apps/organization-api
git commit -m "feat(skills): manage customer skill repositories"
```

---

### Task 18: Build deterministic signed Skill bundles

**Files:**
- Private: `services/skill-release/src/bundle-builder.ts`
- Private: `services/skill-release/src/bundle-signer.ts`
- Private: `services/skill-release/src/risk-classifier.ts`
- Private: `services/skill-release/src/release-service.ts`
- Private: `services/skill-release/test/bundle.test.ts`
- Public: `packages/skill-manager/src/bundle-verifier.ts`
- Public: `packages/skill-manager/test/bundle-verifier.test.ts`

**Interfaces:**
- Produces deterministic archive, `SkillBundle`, signature, release record, and local verification.

- [ ] **Step 1: Write deterministic build tests**

Two builds from the same exact commits and manifests must produce the same content hash.

- [ ] **Step 2: Write signature substitution tests**

Reject wrong organization, modified file, modified manifest, wrong signing key, and expired release.

- [ ] **Step 3: Implement bundle assembly and risk classification**

Risk classification examines effective permissions and install targets, not only changed filenames.

- [ ] **Step 4: Bind evaluation receipts and rollback ancestry**

A release cannot reference a missing or failed required gate.

- [ ] **Step 5: Publish to organization-scoped object storage and record main-branch manifest**

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- bundle.test.ts
npm test --workspace @dharma-ai/agent-fabric-skill-manager
git add services/skill-release packages/skill-manager
git commit -m "feat(skills): build immutable signed skill bundles"
```

---

### Task 19: Implement automatic Skill installation, activation, and rollback

**Files:**
- Public: `packages/skill-manager/src/install-plan.ts`
- Public: `packages/skill-manager/src/stager.ts`
- Public: `packages/skill-manager/src/activator.ts`
- Public: `packages/skill-manager/src/rollback.ts`
- Public: `packages/skill-manager/src/receipts.ts`
- Public: `packages/skill-manager/src/providers/codex.ts`
- Public: `packages/skill-manager/src/providers/claude.ts`
- Public: `packages/skill-manager/test/install.e2e.test.ts`
- Modify: `apps/relay-daemon/src/main.ts`

**Interfaces:**
- Produces `planInstall`, `stage`, `verify`, `activate`, `rollback`, and signed receipts.

- [ ] **Step 1: Write staged-install and active-version tests**

A failed stage must not change the active bundle. A running task remains pinned to its starting bundle.

- [ ] **Step 2: Implement Codex and Claude native install targets**

Use project or plugin scopes documented by the host. Do not place generated mirrors into canonical Skill source.

- [ ] **Step 3: Implement provider-specific verification and activation modes**

Return `next_task`, `next_session`, `host_restart`, or `immediate_safe_reload` accurately.

- [ ] **Step 4: Implement atomic activation and rollback**

Forced verification failure restores the previous known-good bundle and returns a rollback receipt.

- [ ] **Step 5: Run end-to-end tests and native smokes**

- [ ] **Step 6: Commit**

```bash
git add packages/skill-manager apps/relay-daemon
git commit -m "feat(skills): install and roll back organization skill bundles"
```

---

### Task 20: Implement deterministic evaluation and semantic judge accounting

**Files:**
- Private: `services/deterministic-evals/src/evaluator.ts`
- Private: `services/deterministic-evals/src/verifier-registry.ts`
- Private: `services/judge-service/src/judge-service.ts`
- Private: `services/judge-service/src/prompt-registry.ts`
- Private: `services/judge-service/src/usage-recorder.ts`
- Private: `test/agent-fabric/evaluation.test.ts`
- Private: `test/agent-fabric/judge-isolation.test.ts`

**Interfaces:**
- Produces deterministic results and bounded semantic judge results with exact usage and cost.

- [ ] **Step 1: Write deterministic verifier tests**

Cover schema, state, command, Git, Skill version, validation, hidden-truth assertions, and missing-evidence behavior.

- [ ] **Step 2: Implement the verifier registry**

Each verifier declares required evidence, version, deterministic result, and unsupported state.

- [ ] **Step 3: Write hidden-truth isolation tests**

Assert that evaluated agent inputs never include hidden truth or held-out expected outputs.

- [ ] **Step 4: Implement judge service**

Record model, provider, prompt version, input hashes, output, confidence, tokens, and cost. Do not fill unavailable usage with zero.

- [ ] **Step 5: Add hard caps and idempotency**

A repeated judge request with the same idempotency key returns the original result and cost event.

- [ ] **Step 6: Commit**

```bash
git add services/deterministic-evals services/judge-service test
git commit -m "feat(eval): add deterministic verification and semantic judging"
```

---

### Task 21: Implement rubric proposals, Failure Atlas, and remediation PRs

**Files:**
- Private: `services/rubric-authoring/src/rubric-proposal-service.ts`
- Private: `services/failure-atlas/src/failure-family-service.ts`
- Private: `services/failure-atlas/src/instance-service.ts`
- Private: `services/remediation-engine/src/remediation-service.ts`
- Private: `services/remediation-engine/src/skill-target-selector.ts`
- Private: `test/agent-fabric/remediation.e2e.test.ts`

**Interfaces:**
- Produces versioned rubric proposals, failure families, candidate Skill changes, and remediation PRs.

- [ ] **Step 1: Write tests separating failure instances from failure families**

Similar vocabulary alone must not merge failures. Require compatible observed condition, responsible layer, consequence, and remediation route.

- [ ] **Step 2: Implement rubric proposal generation**

The service outputs deterministic verifier candidates, semantic criteria, evidence requirements, missing-evidence behavior, held-out cases, and promotion gates.

- [ ] **Step 3: Implement failure attribution**

Represent `agent`, `handoff`, `environment`, `mixed`, and `unresolved` explicitly.

- [ ] **Step 4: Implement smallest-owner remediation targeting**

Prefer Skill or policy changes when supported. Code remediation requires explicit customer authority.

- [ ] **Step 5: Create the customer Skill PR through Task 17's GitHub service**

- [ ] **Step 6: Run end-to-end remediation test and commit**

```bash
npm test -- remediation.e2e.test.ts
git add services/rubric-authoring services/failure-atlas services/remediation-engine test
git commit -m "feat(remediation): turn trajectory failures into skill proposals"
```

---

### Task 22: Implement held-out validation, rollout, and post-release outcome measurement

**Files:**
- Private: `services/replay-runner/src/historical-runner.ts`
- Private: `services/replay-runner/src/held-out-runner.ts`
- Private: `services/skill-release/src/rollout-service.ts`
- Private: `services/skill-release/src/health-evaluator.ts`
- Private: `services/failure-atlas/src/outcome-window.ts`
- Private: `test/agent-fabric/rollout.e2e.test.ts`

**Interfaces:**
- Produces historical, matched, held-out, regression, canary, rollout, rollback, and post-rollout results.

- [ ] **Step 1: Write tests preventing hidden case leakage**

The Skill candidate and evaluated agents cannot access held-out answers before output freeze.

- [ ] **Step 2: Implement validation ladder orchestration**

The required gates depend on risk class. Historical replay alone never marks remediation verified.

- [ ] **Step 3: Implement canary cohort selection and health policy**

Use exact device and workspace selectors. Exclude incompatible or offline devices without counting them as successful.

- [ ] **Step 4: Implement automatic expansion and rollback**

A forced canary failure returns all canaries to the previous bundle.

- [ ] **Step 5: Implement later outcome windows**

Measure recurrence, time to recovery, correction burden, validation, and agreed customer outcome. Support an explicit no-improvement result.

- [ ] **Step 6: Commit**

```bash
git add services/replay-runner services/skill-release services/failure-atlas test
git commit -m "feat(rollout): validate and measure skill remediations"
```

---

### Task 23: Integrate managed execution, BYOK, billing, and hard caps

**Files:**
- Private: `services/managed-runner/src/runner.ts`
- Private: `packages/model-gateway/src/model-gateway.ts`
- Private: `services/billing/src/usage-service.ts`
- Private: `services/billing/src/cost-estimator.ts`
- Private: `services/billing/src/hard-cap.ts`
- Private: `apps/organization-api/src/routes/agent-fabric-usage.ts`
- Private: `test/agent-fabric/billing.e2e.test.ts`

**Interfaces:**
- Produces managed task execution, BYOK model execution, cost estimates, usage events, and cap decisions.

- [ ] **Step 1: Write mode-separation tests**

A local Codex task records no Dharma model token event. A server semantic judge records an Analysis Token event. A managed task records an Environment Token event.

- [ ] **Step 2: Implement purpose-class usage events**

Every event binds organization, workspace, task or eval, model, usage, estimate, actual cost, payer, and source receipt.

- [ ] **Step 3: Implement hard caps**

Test reject, approval-required, deterministic-only downgrade, and model downgrade behaviors.

- [ ] **Step 4: Integrate with the existing organization ledger**

Keep Agent Fabric usage separate from CC-02 RAG and chat usage.

- [ ] **Step 5: Run billing reconciliation test and commit**

```bash
npm test -- billing.e2e.test.ts
git add services/managed-runner packages/model-gateway services/billing apps/organization-api test
git commit -m "feat(billing): meter managed and semantic agent fabric usage"
```

---

### Task 24: Publish the Codex Skill and MCP app

**Files:**
- Public: `.codex-plugin/plugin.json`
- Public: `skills/dharma-agent-fabric/SKILL.md`
- Public: `skills/dharma-agent-fabric/references/*.md`
- Private: `apps/mcp-server/src/server.ts`
- Private: `apps/mcp-server/src/tools/*.ts`
- Private: `apps/mcp-server/src/oauth.ts`
- Private: `test/agent-fabric/mcp-tools.test.ts`
- Create: `docs/openai-publication-checklist.md`

**Interfaces:**
- Produces a discoverable Codex Skill and authenticated organization MCP tools.

- [ ] **Step 1: Validate the current OpenAI plugin and app contract**

Re-check official OpenAI documentation and the installed Codex version. Record the manifest and publication behavior used. Do not copy an obsolete manifest field.

- [ ] **Step 2: Install the supplied public Skill and plugin scaffold**

Use the package Skill as the baseline. Update only commands and URLs that the implementation actually supports.

- [ ] **Step 3: Write MCP tool input, permission, and idempotency tests**

Read tools preserve source membership. Write tools require exact organization capability and return audit correlation IDs.

- [ ] **Step 4: Implement the read tools**

Start with devices, agents, workspaces, trajectories, evaluations, failure families, Skills, rollouts, and usage.

- [ ] **Step 5: Implement bounded write tools**

Add evaluation, task, message, remediation, Skill release, rollout, rollback, and evidence request. Do not add arbitrary shell or file tools.

- [ ] **Step 6: Add confirmation metadata and cost previews**

Task, evidence, judge, remediation, release, rollout, and rollback actions expose target and effect before execution.

- [ ] **Step 7: Run plugin discovery and MCP app tests**

Use a test organization and low-risk fixture workspace.

- [ ] **Step 8: Commit**

```bash
git add .codex-plugin skills apps/mcp-server test docs/openai-publication-checklist.md
git commit -m "feat(plugin): publish agent fabric skill and mcp app"
```

---

## Final Pilot Verification

Run one complete pilot scenario:

1. Enroll a Windows or WSL device.
2. Register one repository.
3. Detect Codex and Claude capabilities.
4. Capture at least 100 real or representative task episodes under approved policy.
5. Upload reduced full-session capsules.
6. Request one expanded evidence span.
7. Identify a repeated failure family.
8. Generate a rubric proposal and Skill remediation PR.
9. Pass historical, matched, held-out, and regression gates.
10. Release a signed canary bundle.
11. Install and verify it automatically.
12. Dispatch one local task through the new Skill.
13. Force one bad canary and prove rollback.
14. Complete a later outcome window.
15. Export the remediation package.
16. Reconcile local BYOK, server judge, and managed environment costs.
17. Exercise the corresponding MCP read and write tools.

## Final Release Checklist

- [ ] All schemas validate.
- [ ] Public package and upstream notices verify.
- [ ] Cross-platform local tests pass.
- [ ] Codex and Claude native smokes pass.
- [ ] No fixture secret appears in capsule, log, object, or report.
- [ ] Cross-workspace and cross-tenant negative tests pass.
- [ ] Device revocation passes.
- [ ] Replay and expiry tests pass.
- [ ] Worktree escape tests pass.
- [ ] Task branch default authority passes.
- [ ] Skill signatures, canary, activation, and rollback pass.
- [ ] Hidden-truth isolation passes.
- [ ] Billing mode separation passes.
- [ ] MCP source permissions and action confirmations pass.
- [ ] Customer privacy, retention, and employee disclosure documents are approved.
- [ ] Known provider and evidence limitations are published.

## Execution Handoff

Implement with subagent-driven development, one task at a time, with independent review after each vertical slice. The Phase 1 local-only capture gate is the first mandatory checkpoint before network or remote mutation work proceeds.
