export type AgentFabricRuntimeMode = 'dharma_managed' | 'gcp_vertex_byok' | 'local_byok';
export type AgentFabricProvider = 'codex' | 'claude' | 'agy' | 'managed' | 'gcp_vertex_byok';

export interface AgentFabricClientOptions {
  organizationId: string;
  token: string | (() => string | Promise<string>);
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export interface AgentFabricRequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface AgentFabricStateEnvelope {
  intent: string;
  evidence_used: string[];
  known_state: Record<string, unknown>;
  unknown_or_missing_state: string[];
  allowed_next_actions: string[];
  blocked_actions: string[];
  decision_authority: string;
  tool_results: unknown[];
}

export interface AgentFabricEvidenceReference {
  trajectoryId: string;
  revision: number;
  capsuleHash: `sha256:${string}`;
}

export interface AgentFabricHandoffInput {
  sourceTaskId: string;
  targetEndpointId: string;
  conversationId?: string;
  requestedResponse: 'status_update' | 'proposal' | 'evidence_request' | 'task_result' | 'clarification';
  responseInstructions?: string;
  stateEnvelope: AgentFabricStateEnvelope;
  evidenceReferences?: AgentFabricEvidenceReference[];
}

export interface AgentFabricGcpByokConfiguration {
  action?: 'configure';
  projectId: string;
  projectNumber: string;
  region: string;
  runtimeUrl: string;
  runtimeServiceName: string;
  serviceAccountEmail: string;
  spendCeilingUsd?: number;
}

export interface AgentFabricImageAttachment {
  displayName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataBase64: string;
  sha256: `sha256:${string}`;
}

export interface AgentFabricManagedRunInput {
  agentId: string;
  prompt: string;
  attachments?: AgentFabricImageAttachment[];
  metadata?: Record<string, unknown>;
  maxRuntimeSeconds?: number;
  estimatedCredits?: number;
}

export interface AgentFabricRepositoryAgentInput {
  sourceFingerprint: `sha256:${string}`;
  displayName: string;
  defaultSourceRef?: string | null;
}

export interface AgentFabricLocalEndpointInput {
  workspaceId: string;
  provider: 'codex' | 'claude' | 'agy';
  priority?: number;
}

export interface AgentFabricRuntimeEndpointInput {
  endpointKind: 'managed_runtime' | 'cloud_byok';
  managedAgentId: string;
  runtimeBindingId: string;
  priority?: number;
}

export interface AgentFabricAnalysisScope {
  mode: 'organization' | 'agents' | 'endpoints';
  organizationAgentIds?: string[];
  endpointIds?: string[];
}

export type AgentFabricRemediationAction = 'stage_evaluation' | 'run_backtest' | 'link_backtest' | 'approve' | 'merge_pr' | 'release' | 'expand' | 'rollback';

export type AgentFabricRemediationActionInput =
  | {
    action: 'stage_evaluation';
    endpointId: string;
    trajectoryIds?: never;
    campaignId?: never;
    establishAutoUpdatePolicy?: never;
  }
  | {
    action: Exclude<AgentFabricRemediationAction, 'stage_evaluation'>;
    endpointId?: never;
    trajectoryIds?: string[];
    campaignId?: string;
    establishAutoUpdatePolicy?: boolean;
  };

export interface AgentFabricErrorEnvelope {
  ok: false;
  error: { code: string; message: string; correlationId?: string | null };
}

export class AgentFabricApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(status: number, payload: unknown) {
    const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const error = envelope.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown>
      : envelope;
    super(typeof error.message === 'string' ? error.message : `Dharma Agent Fabric request failed with status ${status}.`);
    this.name = 'AgentFabricApiError';
    this.status = status;
    this.code = typeof error.code === 'string' ? error.code : 'agent_fabric_request_failed';
    this.correlationId = typeof error.correlationId === 'string' ? error.correlationId : null;
  }
}

function normalizedBaseUrl(value: string | undefined) {
  const raw = String(value || 'https://www.dharma-ai.io');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Agent Fabric baseUrl must be a valid URL.'); }
  const localhostHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localhostHttp) {
    throw new Error('Agent Fabric baseUrl must be HTTPS or localhost.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('Agent Fabric baseUrl must be a credential-free origin.');
  }
  return parsed.origin;
}

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('This runtime does not provide crypto.randomUUID(). Supply idempotencyKey explicitly.');
}

export class AgentFabricClient {
  readonly organizationId: string;
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  readonly tokenSource: AgentFabricClientOptions['token'];

  constructor(options: AgentFabricClientOptions) {
    if (!options.organizationId.trim()) throw new Error('organizationId is required.');
    if (typeof options.token === 'string' && !options.token.trim()) throw new Error('token is required.');
    this.organizationId = options.organizationId;
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetcher = options.fetcher || fetch;
    this.tokenSource = options.token;
  }

  async request<T>(method: string, path: string, body?: unknown, options: AgentFabricRequestOptions = {}): Promise<T> {
    if (!path.startsWith('/')) throw new Error('Agent Fabric path must start with /.');
    const token = typeof this.tokenSource === 'function' ? await this.tokenSource() : this.tokenSource;
    if (!token.trim()) throw new Error('Agent Fabric token resolver returned an empty token.');
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(mutation ? { 'idempotency-key': options.idempotencyKey || idempotencyKey() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
    let payload: unknown = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new AgentFabricApiError(response.status, payload);
    return payload as T;
  }

  orgPath(path: string) {
    return `/api/v1/orgs/${encodeURIComponent(this.organizationId)}/agent-fabric${path}`;
  }

  onboarding() { return this.request<Record<string, unknown>>('GET', this.orgPath('/onboarding')); }
  startOnboarding(input: { companyName: string; runtimeMode: AgentFabricRuntimeMode; spendCeilingUsd?: number }, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/onboarding'), input, options);
  }
  advanceOnboarding(options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/onboarding'), { action: 'advance' }, options);
  }
  gcpByok() { return this.request<Record<string, unknown>>('GET', this.orgPath('/byok/gcp')); }
  configureGcpByok(input: AgentFabricGcpByokConfiguration, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/byok/gcp'), { ...input, action: 'configure' }, options);
  }
  verifyGcpByok(options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/byok/gcp'), { action: 'verify' }, options);
  }
  listDevices() { return this.request<Record<string, unknown>>('GET', this.orgPath('/devices')); }
  instructions() { return this.request<Record<string, unknown>>('GET', this.orgPath('/instructions')); }
  listAgents() { return this.request<Record<string, unknown>>('GET', this.orgPath('/agents')); }
  listRepositoryAgents() { return this.request<Record<string, unknown>>('GET', this.orgPath('/repository-agents')); }
  connectRepositoryAgent(input: AgentFabricRepositoryAgentInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/repository-agents'), input, options);
  }
  bindLocalEndpoint(agentId: string, input: AgentFabricLocalEndpointInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath(`/agents/${encodeURIComponent(agentId)}/endpoints`), input, options);
  }
  bindRuntimeEndpoint(agentId: string, input: AgentFabricRuntimeEndpointInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath(`/agents/${encodeURIComponent(agentId)}/endpoints`), input, options);
  }
  listWorkspaces() { return this.request<Record<string, unknown>>('GET', this.orgPath('/workspaces')); }
  listTrajectories(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/trajectories${query}`)); }
  listFailures(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/failures${query}`)); }
  listAnalysisWindows(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/evals${query}`)); }
  listRemediations(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/remediations${query}`)); }
  transitionRemediationTarget(targetId: string, input: AgentFabricRemediationActionInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath(`/remediations/${encodeURIComponent(targetId)}`), input, options);
  }
  listSkills(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/skills${query}`)); }
  usage(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/usage${query}`)); }
  dispatchTask(input: Record<string, unknown>, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/tasks'), input, options);
  }
  listTasks(query = '') { return this.request<Record<string, unknown>>('GET', this.orgPath(`/tasks${query}`)); }
  listHandoffs() { return this.request<Record<string, unknown>>('GET', this.orgPath('/conversations')); }
  dispatchHandoff(input: AgentFabricHandoffInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/conversations'), input, options);
  }
  requestAnalysis(input: {
    trajectoryTarget?: number;
    retryWindowId?: string;
    reprocessWindowId?: string;
    scope?: AgentFabricAnalysisScope;
  }, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/evals'), input, options);
  }
  releaseSkill(input: Record<string, unknown>, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath('/skills'), input, options);
  }
  transitionSkillRollout(bundleId: string, input: { action: 'start' | 'expand' | 'rollback'; canaryPercent?: number }, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', this.orgPath(`/skills/${encodeURIComponent(bundleId)}/rollouts`), input, options);
  }
  createManagedAgent(input: Record<string, unknown>, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', `/api/orgs/${encodeURIComponent(this.organizationId)}/managed-agents`, input, options);
  }
  submitManagedRun(input: AgentFabricManagedRunInput, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', `/api/orgs/${encodeURIComponent(this.organizationId)}/agent-runs`, input, options);
  }
  getManagedRun(runId: string) {
    return this.request<Record<string, unknown>>('GET', `/api/orgs/${encodeURIComponent(this.organizationId)}/agent-runs/${encodeURIComponent(runId)}`);
  }
  getManagedRunEvents(runId: string) {
    return this.request<Record<string, unknown>>('GET', `/api/orgs/${encodeURIComponent(this.organizationId)}/agent-runs/${encodeURIComponent(runId)}/events`);
  }
  createManagedEval(input: Record<string, unknown>, options?: AgentFabricRequestOptions) {
    return this.request<Record<string, unknown>>('POST', `/api/orgs/${encodeURIComponent(this.organizationId)}/managed-evals/campaigns`, input, options);
  }
  listManagedTraces(query = '') {
    return this.request<Record<string, unknown>>('GET', `/api/orgs/${encodeURIComponent(this.organizationId)}/managed-traces${query}`);
  }
  listRemediationCandidates(query = '') {
    return this.request<Record<string, unknown>>('GET', `/api/orgs/${encodeURIComponent(this.organizationId)}/managed-remediation/candidates${query}`);
  }
}
