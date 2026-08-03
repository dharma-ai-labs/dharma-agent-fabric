# Data Model

## Storage boundaries

- PostgreSQL stores structured organization state, references, policies, tasks, evaluations, releases, billing, and audit indexes.
- Object storage stores encrypted reduced trajectory chunks, selected expanded evidence, evaluation artifacts, and remediation packages.
- The local SQLite vault stores complete local evidence, disclosure receipts, task state, and skill installations.
- GitHub stores customer skill source, pull-request history, release manifests, and tags.
- Redis or the selected event system stores ephemeral presence, leases, queue state, and resumable delivery metadata. It is not the source of truth.

## Principal PostgreSQL tables

### Organizations and access

#### `agent_fabric_organizations`

- `organization_id`
- `status`
- `default_evidence_mode`
- `default_retention_policy_id`
- `default_budget_policy_id`
- `github_control_repository`
- `created_at`
- `updated_at`

#### `agent_fabric_memberships`

Reference the existing organization membership authority rather than creating an independent user-role system. Store only Agent Fabric-specific capability assignments when needed.

### Devices

#### `agent_fabric_devices`

- `device_id`
- `organization_id`
- `user_id`
- `display_name`
- `platform`
- `environment_kind`
- `public_key`
- `key_version`
- `status`
- `relay_version`
- `last_seen_at`
- `revoked_at`
- `created_at`

#### `agent_fabric_device_sessions`

- `session_id`
- `device_id`
- `connected_at`
- `disconnected_at`
- `last_sequence`
- `schema_versions`
- `remote_address_hash`
- `close_reason`

### Workspaces and providers

#### `agent_fabric_workspaces`

- `workspace_id`
- `organization_id`
- `device_id`
- `repository_identity`
- `display_name`
- `canonical_route_hash`
- `git_remote_hash`
- `default_branch`
- `status`
- `policy_revision`
- `registered_at`
- `last_observed_at`

The server should not require the developer's absolute local path.

#### `agent_fabric_provider_capabilities`

- `device_id`
- `workspace_id`
- `provider_id`
- `provider_version`
- `evidence_status`
- `configured_assets_status`
- `task_execution_status`
- `session_continuation_status`
- `skill_install_status`
- `activation_mode`
- `usage_evidence_status`
- `capability_document`
- `observed_at`

### Trajectories and evidence

#### `agent_fabric_trajectories`

- `trajectory_id`
- `organization_id`
- `device_id`
- `workspace_id`
- `provider_id`
- `provider_session_key_hash`
- `task_id`
- `status`
- `first_event_at`
- `last_event_at`
- `current_revision`
- `evidence_mode`
- `coverage_state`
- `skill_bundle_id`
- `created_at`
- `updated_at`

#### `agent_fabric_trajectory_revisions`

- `trajectory_id`
- `revision`
- `previous_revision_hash`
- `capsule_hash`
- `schema_version`
- `selected_event_count`
- `uploaded_bytes`
- `redacted_count`
- `omitted_count`
- `object_manifest_uri`
- `ingested_at`

#### `agent_fabric_evidence_requests`

- `evidence_request_id`
- `organization_id`
- `trajectory_id`
- `device_id`
- `purpose`
- `selector_document`
- `maximum_bytes`
- `retention_class`
- `requested_by`
- `authority_decision_id`
- `status`
- `expires_at`
- `created_at`
- `completed_at`

#### `agent_fabric_evidence_disclosures`

- `disclosure_id`
- `evidence_request_id`
- `approved_content_ids`
- `excluded_content_ids`
- `redaction_summary`
- `bytes_uploaded`
- `receipt_hash`
- `completed_at`

### Tasks and messages

#### `agent_fabric_tasks`

- `task_id`
- `organization_id`
- `workspace_id`
- `target_device_id`
- `provider_id`
- `status`
- `instruction_hash`
- `task_envelope`
- `skill_bundle_id`
- `base_ref`
- `task_branch`
- `lease_owner`
- `lease_expires_at`
- `budget_policy_id`
- `created_by`
- `created_at`
- `started_at`
- `completed_at`

#### `agent_fabric_task_events`

- `event_id`
- `task_id`
- `sequence`
- `event_type`
- `event_document`
- `occurred_at`
- `received_at`

#### `agent_fabric_conversations`

- `conversation_id`
- `organization_id`
- `task_id`
- `status`
- `created_at`
- `closed_at`

#### `agent_fabric_agent_messages`

- `message_id`
- `conversation_id`
- `source_agent_id`
- `target_selector`
- `state_document`
- `content_object_uri`
- `authority_document`
- `status`
- `expires_at`
- `created_at`
- `delivered_at`

### Evaluations and Failure Atlas

#### `agent_fabric_evaluation_contracts`

- `evaluation_contract_id`
- `organization_id`
- `name`
- `version`
- `status`
- `rubric_document`
- `deterministic_verifiers`
- `judge_configuration`
- `hidden_truth_set_id`
- `approved_by`
- `created_at`

#### `agent_fabric_evaluation_runs`

- `evaluation_run_id`
- `organization_id`
- `evaluation_contract_id`
- `run_type`
- `status`
- `input_manifest`
- `result_manifest`
- `judge_usage_id`
- `cost_cents`
- `started_at`
- `completed_at`

#### `agent_fabric_failure_families`

- `failure_family_id`
- `organization_id`
- `name`
- `normalized_signature`
- `failure_class`
- `severity`
- `confidence`
- `applicability_document`
- `status`
- `created_at`
- `updated_at`

#### `agent_fabric_failure_instances`

- `failure_instance_id`
- `failure_family_id`
- `trajectory_id`
- `task_id`
- `evidence_refs`
- `cause_class`
- `consequence_document`
- `observed_at`

### Remediation and skills

#### `agent_fabric_remediations`

- `remediation_id`
- `organization_id`
- `failure_family_id`
- `status`
- `target_type`
- `target_skill_id`
- `causal_theory`
- `source_commit`
- `pull_request_url`
- `risk_class`
- `evaluation_manifest`
- `release_candidate_id`
- `created_at`

#### `agent_fabric_skills`

- `skill_id`
- `organization_id`
- `display_name`
- `authoring_branch`
- `status`
- `current_released_version`
- `created_at`

#### `agent_fabric_skill_bundles`

- `bundle_id`
- `organization_id`
- `version`
- `manifest_document`
- `bundle_hash`
- `signature`
- `risk_class`
- `rollback_bundle_id`
- `release_status`
- `created_at`
- `released_at`

#### `agent_fabric_skill_rollouts`

- `rollout_id`
- `bundle_id`
- `target_selector`
- `stage`
- `status`
- `health_policy`
- `started_at`
- `completed_at`

#### `agent_fabric_skill_installations`

- `installation_id`
- `rollout_id`
- `device_id`
- `workspace_id`
- `provider_id`
- `previous_bundle_id`
- `status`
- `activation_mode`
- `receipt_document`
- `started_at`
- `completed_at`

### Billing and audit

#### `agent_fabric_usage_events`

- `usage_event_id`
- `organization_id`
- `workspace_id`
- `task_id`
- `evaluation_run_id`
- `purpose_class`
- `execution_mode`
- `model_provider`
- `model_id`
- `input_tokens`
- `output_tokens`
- `cached_tokens`
- `compute_milliseconds`
- `storage_bytes`
- `estimated_cost_cents`
- `actual_cost_cents`
- `hard_cap_decision`
- `occurred_at`

#### `agent_fabric_audit_events`

- `audit_event_id`
- `organization_id`
- `actor_type`
- `actor_id`
- `device_id`
- `workspace_id`
- `action`
- `resource_type`
- `resource_id`
- `request_hash`
- `policy_revision`
- `decision`
- `outcome`
- `receipt_uri`
- `occurred_at`

## Row-level and service authorization

Every query binds `organization_id`. Device and workspace operations additionally bind `device_id` and `workspace_id`. Raw service-role database clients remain infrastructure-only; feature code uses organization-bound repositories.

## Indexing

Required indexes include:

- device status and last seen;
- workspace by organization and repository identity;
- trajectory by organization, workspace, provider, and event time;
- task status and lease expiry;
- message target and expiry;
- failure family signature;
- skill rollout stage and device state;
- usage by organization, purpose, and billing window;
- audit by organization, actor, action, and time.

## Data migration strategy

Add Agent Fabric tables as an isolated schema or clearly prefixed table family. Do not reuse CC-02 RAG tables or token entities for trajectory content. Integrate only through stable organization, identity, billing, and audit boundaries.
