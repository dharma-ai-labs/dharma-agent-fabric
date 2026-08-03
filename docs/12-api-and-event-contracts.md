# API and Event Contracts

## API boundary

The existing Dharma organization control plane remains the public organization API. The relay gateway and evaluation services are internal execution services.

Suggested base path:

```text
/api/orgs/:orgId/agent-fabric
```

## Organization APIs

### Device enrollment

```http
POST /api/orgs/:orgId/agent-fabric/device-enrollments
```

Creates a short-lived device authorization request.

```http
POST /api/orgs/:orgId/agent-fabric/devices/complete-enrollment
```

Binds a device public key after user authorization.

```http
GET /api/orgs/:orgId/agent-fabric/devices
GET /api/orgs/:orgId/agent-fabric/devices/:deviceId
POST /api/orgs/:orgId/agent-fabric/devices/:deviceId/revoke
```

### Workspaces

```http
POST /api/orgs/:orgId/agent-fabric/workspaces
GET /api/orgs/:orgId/agent-fabric/workspaces
PATCH /api/orgs/:orgId/agent-fabric/workspaces/:workspaceId
POST /api/orgs/:orgId/agent-fabric/workspaces/:workspaceId/pause
POST /api/orgs/:orgId/agent-fabric/workspaces/:workspaceId/resume
```

### Trajectories

```http
GET /api/orgs/:orgId/agent-fabric/trajectories
GET /api/orgs/:orgId/agent-fabric/trajectories/:trajectoryId
POST /api/orgs/:orgId/agent-fabric/trajectories/:trajectoryId/evidence-requests
GET /api/orgs/:orgId/agent-fabric/evidence-requests/:requestId
```

### Tasks

```http
POST /api/orgs/:orgId/agent-fabric/tasks
GET /api/orgs/:orgId/agent-fabric/tasks
GET /api/orgs/:orgId/agent-fabric/tasks/:taskId
POST /api/orgs/:orgId/agent-fabric/tasks/:taskId/messages
POST /api/orgs/:orgId/agent-fabric/tasks/:taskId/cancel
```

### A2A conversations

```http
POST /api/orgs/:orgId/agent-fabric/conversations
GET /api/orgs/:orgId/agent-fabric/conversations/:conversationId
POST /api/orgs/:orgId/agent-fabric/conversations/:conversationId/messages
```

### Evaluation

```http
POST /api/orgs/:orgId/agent-fabric/evaluation-contracts
GET /api/orgs/:orgId/agent-fabric/evaluation-contracts
POST /api/orgs/:orgId/agent-fabric/evaluation-runs
GET /api/orgs/:orgId/agent-fabric/evaluation-runs/:runId
POST /api/orgs/:orgId/agent-fabric/rubric-proposals
```

### Failure Atlas and remediation

```http
GET /api/orgs/:orgId/agent-fabric/failure-families
GET /api/orgs/:orgId/agent-fabric/failure-families/:failureFamilyId
POST /api/orgs/:orgId/agent-fabric/failure-families/:failureFamilyId/remediations
GET /api/orgs/:orgId/agent-fabric/remediations/:remediationId
POST /api/orgs/:orgId/agent-fabric/remediations/:remediationId/validate
```

### Skills and releases

```http
GET /api/orgs/:orgId/agent-fabric/skills
GET /api/orgs/:orgId/agent-fabric/skills/:skillId
POST /api/orgs/:orgId/agent-fabric/skill-bundles
GET /api/orgs/:orgId/agent-fabric/skill-bundles/:bundleId
POST /api/orgs/:orgId/agent-fabric/skill-bundles/:bundleId/release
GET /api/orgs/:orgId/agent-fabric/rollouts/:rolloutId
POST /api/orgs/:orgId/agent-fabric/rollouts/:rolloutId/rollback
```

### Billing

```http
GET /api/orgs/:orgId/agent-fabric/usage
POST /api/orgs/:orgId/agent-fabric/cost-estimates
GET /api/orgs/:orgId/agent-fabric/budgets
PATCH /api/orgs/:orgId/agent-fabric/budgets/:budgetId
```

## Relay internal APIs

### Capsule intake

```http
POST /internal/agent-fabric/v1/trajectory-manifests
POST /internal/agent-fabric/v1/trajectory-manifests/:manifestId/complete
```

The first call returns scoped object-upload URLs.

### Evidence expansion

```http
POST /internal/agent-fabric/v1/evidence-responses
POST /internal/agent-fabric/v1/evidence-responses/:responseId/complete
```

### Task artifacts

```http
POST /internal/agent-fabric/v1/tasks/:taskId/artifact-manifests
POST /internal/agent-fabric/v1/tasks/:taskId/artifact-manifests/:manifestId/complete
```

## Error contract

```json
{
  "error": {
    "code": "agent_fabric.task_authority_denied",
    "message": "The task exceeds the workspace authority policy.",
    "requestId": "uuid",
    "retryable": false,
    "details": {
      "deniedCapability": "git.merge"
    }
  }
}
```

Stable error families:

- `agent_fabric.auth.*`
- `agent_fabric.device.*`
- `agent_fabric.workspace.*`
- `agent_fabric.evidence.*`
- `agent_fabric.task.*`
- `agent_fabric.message.*`
- `agent_fabric.eval.*`
- `agent_fabric.skill.*`
- `agent_fabric.billing.*`
- `agent_fabric.internal.*`

Do not reveal whether another organization's resource exists.

## Idempotency

Mutation endpoints require `Idempotency-Key`. Same key and same canonical request returns the original result. Same key with a different fingerprint returns `409`.

## Pagination

Use stable cursor pagination. Cursors bind to organization, filters, and sort order.

## MCP tool mapping

The remote MCP app maps user intents to organization APIs. It does not expose internal relay endpoints.

| MCP tool | Organization API |
| --- | --- |
| `list_devices` | `GET .../devices` |
| `list_agents` | aggregated device/provider capabilities |
| `get_trajectory_summary` | `GET .../trajectories/:id` |
| `request_additional_evidence` | `POST .../evidence-requests` |
| `dispatch_task` | `POST .../tasks` |
| `send_agent_message` | `POST .../conversations/:id/messages` |
| `create_evaluation` | `POST .../evaluation-runs` |
| `propose_remediation` | `POST .../remediations` |
| `create_skill_release` | `POST .../skill-bundles` |
| `rollout_skill_release` | `POST .../skill-bundles/:id/release` |
| `rollback_skill_release` | `POST .../rollouts/:id/rollback` |
| `estimate_cost` | `POST .../cost-estimates` |

## Confirmation classes for app actions

- Read-only inspection: no extra confirmation after normal authentication.
- Evaluation creation: show scope and estimated cost.
- Task dispatch: confirm target, authority, provider, and maximum cost.
- Evidence expansion: confirm purpose, content depth, retention, and byte cap when policy requires it.
- Skill release: confirm risk class, target cohort, evidence gate, and rollback.
- Merge, deploy, secret, or destructive authority: separate explicit confirmation and source-system authorization.
