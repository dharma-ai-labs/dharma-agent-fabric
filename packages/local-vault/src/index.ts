import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256, type SessionBindingScope } from '@dharma-ai-labs/agent-fabric-contracts';
import { trajectoryCapsuleHash } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

const BLOB_VERSION = 1;

export interface VaultOptions {
  root: string;
  masterKey: Buffer;
  rawLocalDays?: number;
}

export interface VaultCaptureInput {
  raw: { plaintext: Uint8Array; kind: string; expectedContentId: string };
  capsule: {
    plaintext: Uint8Array;
    trajectoryId: string;
    revision: number;
    capsuleHash: string;
  };
  session: {
    sessionId: string;
    provider: string;
    workspaceId: string;
    sourceLocator: string;
    status: string;
    observedAt: string;
  };
}

export interface LocalProviderSessionBinding extends SessionBindingScope {
  schema: 'dharma.local-provider-session-binding/v1';
  owner: 'dharma_bridge' | 'cooperative_session';
  sessionId: string;
  workspaceRoot: string;
  createdAt: string;
}

export type LocalProviderSessionIdentity = Pick<SessionBindingScope,
  'organizationId' | 'repositoryBindingId' | 'workspaceId' | 'endpointId'
  | 'membershipId' | 'deviceId' | 'provider'>;

export interface LocalProviderSessionLease {
  assertHeld(): Promise<boolean>;
  release(): void;
}

export type LocalCodexSetupResult = {state: 'completed'; readinessReceiptId: string}
  | {state: 'unconfirmed'; code: 'setup_execution_unconfirmed'};
export type LocalCodexSetupClaim = {state: 'acquired'; leaseId: string; intentDigest: string}
  | {state: 'running'; intentDigest: string}
  | {state: 'terminal'; intentDigest: string; result: LocalCodexSetupResult};
interface CodexSetupRow {
  operation_id: string; intent_digest: string; lease_hash: string; state: 'running' | 'terminal';
  nonce: Uint8Array | null; tag: Uint8Array | null; ciphertext: Uint8Array | null;
}
const setupId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const setupDigest = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
function parseCodexSetupResult(value: unknown): LocalCodexSetupResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('setup_operation_invalid');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== 2
    || Reflect.ownKeys(properties).some(key => typeof key !== 'string'
      || !Object.hasOwn(properties[key]!, 'value'))) throw new Error('setup_operation_invalid');
  if (properties.state?.value === 'completed' && properties.readinessReceiptId
    && typeof properties.readinessReceiptId.value === 'string' && setupId.test(properties.readinessReceiptId.value)) {
    return {state: 'completed', readinessReceiptId: properties.readinessReceiptId.value};
  }
  if (properties.state?.value === 'unconfirmed' && properties.code?.value === 'setup_execution_unconfirmed') {
    return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
  }
  throw new Error('setup_operation_invalid');
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function assertLocalProviderSessionBinding(value: unknown): asserts value is LocalProviderSessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider_session_binding_invalid');
  }
  const record = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (Object.keys(record).some(key => ![
    'schema', 'owner', 'organizationId', 'repositoryBindingId', 'workspaceId',
    'endpointId', 'membershipId', 'deviceId', 'bindingId', 'provider',
    'sessionId', 'workspaceRoot', 'createdAt', 'expiresAt', 'maximumProviderCostCents',
  ].includes(key))
    || record.schema !== 'dharma.local-provider-session-binding/v1'
    || (record.owner !== 'dharma_bridge' && record.owner !== 'cooperative_session')
    || typeof record.organizationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(record.organizationId)
    || ![record.repositoryBindingId, record.workspaceId, record.endpointId,
      record.membershipId, record.deviceId, record.bindingId]
      .every(id => typeof id === 'string' && uuid.test(id))
    || typeof record.provider !== 'string'
    || !['codex', 'claude', 'agy', 'hermes'].includes(record.provider)
    || typeof record.sessionId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(record.sessionId)
    || typeof record.workspaceRoot !== 'string'
    || !isAbsolute(record.workspaceRoot) || resolve(record.workspaceRoot) !== record.workspaceRoot
    || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
    || !Number.isFinite(Date.parse(record.expiresAt))
    || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
    || !Number.isInteger(record.maximumProviderCostCents)
    || Number(record.maximumProviderCostCents) < 0 || Number(record.maximumProviderCostCents) > 10_000) {
    throw new Error('provider_session_binding_invalid');
  }
}

function sameLocalProviderSessionIdentity(
  record: LocalProviderSessionBinding, expected: LocalProviderSessionIdentity,
): boolean {
  return record.organizationId === expected.organizationId
    && record.repositoryBindingId === expected.repositoryBindingId
    && record.workspaceId === expected.workspaceId
    && record.endpointId === expected.endpointId
    && record.membershipId === expected.membershipId
    && record.deviceId === expected.deviceId
    && record.provider === expected.provider;
}

export class LocalVault {
  readonly root: string;
  readonly #masterKey: Buffer;
  readonly #database: DatabaseSync;

  private constructor(options: VaultOptions, database: DatabaseSync) {
    this.root = options.root;
    this.#masterKey = options.masterKey;
    this.#database = database;
  }

  static async open(options: VaultOptions): Promise<LocalVault> {
    if (options.masterKey.length !== 32) throw new Error('Vault master key must contain exactly 32 bytes.');
    await mkdir(resolve(options.root, 'blobs'), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(resolve(options.root, 'vault.sqlite'));
    database.exec(`
      pragma journal_mode = WAL;
      create table if not exists blobs (
        content_id text primary key,
        bytes integer not null,
        kind text not null,
        created_at text not null
      );
      create table if not exists sessions (
        session_id text primary key,
        provider text not null,
        workspace_id text not null,
        source_locator_hash text not null,
        status text not null,
        observed_at text not null
      );
      create table if not exists capsules (
        trajectory_id text not null,
        revision integer not null,
        capsule_hash text not null,
        blob_content_id text not null,
        created_at text not null,
        primary key (trajectory_id, revision)
      );
      create table if not exists disclosures (
        disclosure_id text primary key,
        receipt_hash text not null,
        bytes_uploaded integer not null,
        created_at text not null
      );
      create table if not exists capsule_sync_queue (
        trajectory_id text not null,
        revision integer not null,
        blob_content_id text not null,
        created_at text not null,
        primary key (trajectory_id, revision)
      );
      create table if not exists capsule_sync_failures (
        trajectory_id text not null,
        revision integer not null,
        reason text not null,
        recorded_at text not null,
        primary key (trajectory_id, revision)
      );
      create table if not exists capsule_content_refs (
        trajectory_id text not null,
        revision integer not null,
        content_id text not null,
        available_locally integer not null,
        primary key (trajectory_id, revision, content_id)
      );
      create table if not exists task_completion_recovery (
        task_id text primary key,
        blob_content_id text not null,
        created_at text not null
      );
      create table if not exists provider_session_bindings (
        binding_id text primary key,
        session_locator_hash text not null unique,
        nonce blob not null,
        tag blob not null,
        ciphertext blob not null,
        revoked_at text
      );
      create table if not exists provider_session_leases (
        binding_id text primary key references provider_session_bindings(binding_id),
        holder_id text not null,
        host_name text not null,
        owner_pid integer not null,
        acquired_at text not null
      );
      create table if not exists provider_session_binding_renewals (
        binding_id text not null references provider_session_bindings(binding_id),
        previous_expires_at text not null,
        nonce blob not null,
        tag blob not null,
        ciphertext blob not null,
        renewed_at text not null,
        primary key (binding_id, previous_expires_at)
      );
      create table if not exists provider_session_replies (
        binding_id text not null references provider_session_bindings(binding_id),
        question_id text not null,
        blob_content_id text not null references blobs(content_id),
        created_at text not null,
        acknowledged_at text,
        primary key (binding_id, question_id)
      );
      create table if not exists provider_session_reply_dispositions (
        binding_id text not null,
        question_id text not null,
        completion_hash text not null references blobs(content_id),
        disposition_hash text not null references blobs(content_id),
        primary key (binding_id, question_id),
        foreign key (binding_id, question_id) references provider_session_replies(binding_id, question_id)
      );
      create table if not exists provider_session_task_exports (
        binding_id text not null references provider_session_bindings(binding_id),
        work_key text not null,
        descriptor_hash text not null references blobs(content_id),
        created_at text not null,
        acknowledged_at text,
        receipt_hash text references blobs(content_id),
        primary key (binding_id, work_key)
      );
      create table if not exists codex_setup_operations (
        operation_id text primary key,
        intent_digest text not null,
        lease_hash text not null unique,
        state text not null check (state in ('running', 'terminal')),
        nonce blob,
        tag blob,
        ciphertext blob,
        check ((state = 'running' and nonce is null and tag is null and ciphertext is null)
          or (state = 'terminal' and nonce is not null and tag is not null and ciphertext is not null))
      );
      create index if not exists blobs_raw_retention_idx on blobs(kind, created_at, content_id);
      create index if not exists capsules_blob_content_id_idx on capsules(blob_content_id);
      create index if not exists capsules_latest_revision_idx on capsules(trajectory_id, revision desc);
      create index if not exists capsule_content_refs_lookup_idx
        on capsule_content_refs(content_id, available_locally, trajectory_id, revision);
    `);
    database.exec('begin immediate');
    try {
      const columns = database.prepare('pragma table_info(provider_session_task_exports)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'receipt_hash')) {
        database.exec('alter table provider_session_task_exports add column receipt_hash text references blobs(content_id)');
      }
      database.exec('commit');
    } catch (error) { database.exec('rollback'); database.close(); throw error; }
    const vault = new LocalVault(options, database);
    await vault.#recoverRetentionQuarantine();
    await vault.#backfillCapsuleContentRefs();
    await vault.enforceRawEvidenceRetention({ retentionDays: options.rawLocalDays ?? 30 });
    return vault;
  }

  async #putBlob(plaintext: Uint8Array, kind: string): Promise<{ contentId: string; created: boolean }> {
    // Hash and encrypt one immutable snapshot across asynchronous filesystem writes.
    plaintext = Buffer.from(plaintext);
    const contentId = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
    const path = this.#blobPath(contentId);
    const existing = this.#database.prepare('select content_id from blobs where content_id = ?').get(contentId);
    if (existing) return { contentId, created: false };

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([Buffer.from([BLOB_VERSION]), nonce, tag, ciphertext]);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' });
    let started = false;
    try {
      // Publish under the SQLite write fence without yielding between metadata
      // insertion and rename. A failed INSERT never creates an unindexed final blob.
      this.#database.exec('savepoint vault_blob_write'); started = true;
      const result = this.#database.prepare(
        'insert into blobs(content_id, bytes, kind, created_at) values (?, ?, ?, ?) on conflict(content_id) do nothing',
      ).run(contentId, plaintext.byteLength, kind, new Date().toISOString());
      const created = Number(result.changes) === 1;
      if (created) renameSync(temporary, path);
      this.#database.exec('release vault_blob_write'); started = false;
      return { contentId, created };
    } catch (error) {
      if (started) {
        try { this.#database.exec('rollback to vault_blob_write; release vault_blob_write'); } catch {}
      }
      // The final address may already belong to a committed writer. Never unlink it.
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  async putBlob(plaintext: Uint8Array, kind: string): Promise<string> {
    return (await this.#putBlob(plaintext, kind)).contentId;
  }

  async stageProviderSessionTaskExport(bindingId: string, identity: LocalProviderSessionIdentity,
    workKey: string, descriptor: Uint8Array): Promise<string> {
    if (!/^sha256:[a-f0-9]{64}$/.test(workKey) || descriptor.byteLength < 1 || descriptor.byteLength > 16384) {
      throw new Error('provider_session_task_export_invalid');
    }
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const hash = `sha256:${createHash('sha256').update(descriptor).digest('hex')}`;
    const prior = this.#database.prepare(`
      select descriptor_hash from provider_session_task_exports where binding_id = ? and work_key = ?
    `).get(bindingId, workKey) as { descriptor_hash: string } | undefined;
    if (prior) {
      if (prior.descriptor_hash !== hash) throw new Error('provider_session_task_export_conflict');
      return hash;
    }
    const stored = await this.putBlob(descriptor, 'provider-session-task-export-descriptor');
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    this.#database.prepare(`
      insert into provider_session_task_exports(binding_id, work_key, descriptor_hash, created_at)
      select ?, ?, ?, ? where exists (
        select 1 from provider_session_bindings where binding_id = ? and revoked_at is null
      ) on conflict(binding_id, work_key) do nothing
    `).run(bindingId, workKey, stored, new Date().toISOString(), bindingId);
    const row = this.#database.prepare(`
      select descriptor_hash from provider_session_task_exports where binding_id = ? and work_key = ?
    `).get(bindingId, workKey) as { descriptor_hash: string } | undefined;
    if (!row) throw new Error('provider_session_binding_unavailable');
    if (row.descriptor_hash !== hash) throw new Error('provider_session_task_export_conflict');
    return stored;
  }

  listProviderSessionTaskExports(bindingId: string, identity: LocalProviderSessionIdentity):
    Array<{ workKey: string; descriptorHash: string }> {
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const rows = this.#database.prepare(`
      select work_key as workKey, descriptor_hash as descriptorHash from provider_session_task_exports
      where binding_id = ? and acknowledged_at is null order by created_at, work_key limit 100
    `).all(bindingId) as Array<{ workKey: string; descriptorHash: string }>;
    return rows.map(row => ({ workKey: row.workKey, descriptorHash: row.descriptorHash }));
  }

  acknowledgeProviderSessionTaskExport(bindingId: string, identity: LocalProviderSessionIdentity,
    workKey: string, descriptorHash: string, receiptHash?: string): void {
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    if (receiptHash && (!/^sha256:[a-f0-9]{64}$/.test(receiptHash)
      || !this.#database.prepare('select 1 from blobs where content_id = ?').get(receiptHash))) {
      throw new Error('provider_session_task_export_conflict');
    }
    const row = this.#database.prepare(`
      select descriptor_hash, receipt_hash from provider_session_task_exports where binding_id = ? and work_key = ?
    `).get(bindingId, workKey) as { descriptor_hash: string; receipt_hash: string | null } | undefined;
    if (!row || row.descriptor_hash !== descriptorHash || (receiptHash && row.receipt_hash && row.receipt_hash !== receiptHash)) {
      throw new Error('provider_session_task_export_conflict');
    }
    const updated = this.#database.prepare(`
      update provider_session_task_exports set acknowledged_at = coalesce(acknowledged_at, ?), receipt_hash = coalesce(receipt_hash, ?)
      where binding_id = ? and work_key = ? and descriptor_hash = ?
        and exists (select 1 from provider_session_bindings where binding_id = ? and revoked_at is null)
        and (receipt_hash is null or ? is null or receipt_hash = ?)
    `).run(new Date().toISOString(), receiptHash ?? null, bindingId, workKey, descriptorHash, bindingId,
      receiptHash ?? null, receiptHash ?? null);
    if (Number(updated.changes) !== 1) throw new Error('provider_session_binding_unavailable');
  }

  latestProviderSessionTaskExportReceipt(bindingId: string, identity: LocalProviderSessionIdentity):
    { descriptorHash: string; receiptHash: string } | null {
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const row = this.#database.prepare(`
      select descriptor_hash as descriptorHash, receipt_hash as receiptHash from provider_session_task_exports
      where binding_id = ? and acknowledged_at is not null and receipt_hash is not null
      order by acknowledged_at desc, work_key desc limit 1
    `).get(bindingId) as { descriptorHash: string; receiptHash: string } | undefined;
    return row ? { descriptorHash: row.descriptorHash, receiptHash: row.receiptHash } : null;
  }

  async stageProviderSessionReply(bindingId: string, identity: LocalProviderSessionIdentity,
    questionId: string, plaintext: Uint8Array): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(questionId)
      || plaintext.byteLength < 1 || plaintext.byteLength > 16384) throw new Error('provider_session_reply_invalid');
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const expectedHash = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
    const existing = this.#database.prepare(`
      select blob_content_id from provider_session_replies where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { blob_content_id: string } | undefined;
    if (existing) {
      if (existing.blob_content_id !== expectedHash) throw new Error('provider_session_reply_conflict');
      return existing.blob_content_id;
    }
    const hash = await this.putBlob(plaintext, 'provider-session-completion');
    // Recheck revocation after the encrypted write; retain evidence on any failure.
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    this.#database.prepare(`
      insert into provider_session_replies(binding_id, question_id, blob_content_id, created_at)
      values (?, ?, ?, ?) on conflict(binding_id, question_id) do nothing
    `).run(bindingId, questionId, hash, new Date().toISOString());
    const staged = this.#database.prepare(`
      select blob_content_id from provider_session_replies where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { blob_content_id: string };
    if (staged.blob_content_id !== hash) throw new Error('provider_session_reply_conflict');
    return hash;
  }

  listProviderSessionReplies(bindingId: string, identity: LocalProviderSessionIdentity):
    Array<{ questionId: string; completionHash: string }> {
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const rows = this.#database.prepare(`
      select r.question_id as questionId, r.blob_content_id as completionHash from provider_session_replies r
      where r.binding_id = ? and r.acknowledged_at is null
        and not exists (select 1 from provider_session_reply_dispositions d
          where d.binding_id = r.binding_id and d.question_id = r.question_id)
      order by r.created_at, r.question_id limit 100
    `).all(bindingId) as Array<{ questionId: string; completionHash: string }>;
    return rows.map(row => ({ questionId: row.questionId, completionHash: row.completionHash }));
  }

  async quarantineExpiredProviderSessionReply(bindingId: string, identity: LocalProviderSessionIdentity,
    questionId: string, completionHash: string, observation: { state: 'expired'; taskId: string; correlationId: string }): Promise<string> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
    if (!uuid.test(questionId) || !/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(completionHash)
      || !observation || Object.keys(observation).sort().join(',') !== 'correlationId,state,taskId'
      || observation.state !== 'expired' || !uuid.test(observation.taskId) || !uuid.test(observation.correlationId)) {
      throw new Error('provider_session_reply_disposition_invalid');
    }
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const row = this.#database.prepare(`
      select blob_content_id, acknowledged_at from provider_session_replies where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { blob_content_id: string; acknowledged_at: string | null } | undefined;
    if (!row || row.blob_content_id !== completionHash || row.acknowledged_at !== null) throw new Error('provider_session_reply_conflict');
    const existing = this.#database.prepare(`
      select completion_hash, disposition_hash from provider_session_reply_dispositions where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { completion_hash: string; disposition_hash: string } | undefined;
    if (existing) {
      if (existing.completion_hash !== completionHash) throw new Error('provider_session_reply_conflict');
      return existing.disposition_hash;
    }
    // Expiry is not delivery. Keep the answer and an encrypted, independently scoped disposition.
    const dispositionHash = await this.putBlob(Buffer.from(JSON.stringify({
      schema: 'dharma.provider-session-expired-reply/v1', ...identity, bindingId, questionId,
      completionHash, ...observation, observedAt: new Date().toISOString(), delivered: false,
    })), 'provider-session-expired-reply');
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    this.#database.prepare(`
      insert into provider_session_reply_dispositions(binding_id, question_id, completion_hash, disposition_hash)
      select binding_id, question_id, blob_content_id, ? from provider_session_replies
      where binding_id = ? and question_id = ? and blob_content_id = ? and acknowledged_at is null
      on conflict(binding_id, question_id) do nothing
    `).run(dispositionHash, bindingId, questionId, completionHash);
    const persisted = this.#database.prepare(`
      select completion_hash, disposition_hash from provider_session_reply_dispositions where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { completion_hash: string; disposition_hash: string } | undefined;
    if (!persisted || persisted.completion_hash !== completionHash) throw new Error('provider_session_reply_conflict');
    return persisted.disposition_hash;
  }

  acknowledgeProviderSessionReply(bindingId: string, identity: LocalProviderSessionIdentity,
    questionId: string, completionHash: string): void {
    if (!this.getProviderSessionBinding(bindingId, identity)) throw new Error('provider_session_binding_unavailable');
    const row = this.#database.prepare(`
      select blob_content_id from provider_session_replies where binding_id = ? and question_id = ?
    `).get(bindingId, questionId) as { blob_content_id: string } | undefined;
    if (!row || row.blob_content_id !== completionHash) throw new Error('provider_session_reply_conflict');
    const disposition = this.#database.prepare(`
      select 1 from provider_session_reply_dispositions where binding_id = ? and question_id = ?
    `).get(bindingId, questionId);
    if (disposition) throw new Error('provider_session_reply_quarantined');
    this.#database.prepare(`
      update provider_session_replies set acknowledged_at = coalesce(acknowledged_at, ?)
      where binding_id = ? and question_id = ? and blob_content_id = ?
    `).run(new Date().toISOString(), bindingId, questionId, completionHash);
  }

  async putFile(sourcePath: string, kind: string): Promise<{ contentId: string; bytes: number }> {
    const source = await stat(sourcePath);
    if (!source.isFile() || source.size < 1) throw new Error('Vault source must be a non-empty file.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    const hash = createHash('sha256');
    const incoming = resolve(this.root, 'blobs', `.incoming-${process.pid}-${randomBytes(8).toString('hex')}`);
    const destination = await open(incoming, 'wx', 0o600);
    try {
      await destination.write(Buffer.concat([Buffer.from([BLOB_VERSION]), nonce, Buffer.alloc(16)]));
      for await (const value of createReadStream(sourcePath, { highWaterMark: 1_048_576 })) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        hash.update(chunk);
        const encrypted = cipher.update(chunk);
        if (encrypted.length) await destination.write(encrypted);
      }
      const final = cipher.final();
      if (final.length) await destination.write(final);
      await destination.write(cipher.getAuthTag(), 0, 16, 13);
    } catch (error) {
      await destination.close().catch(() => undefined);
      await rm(incoming, { force: true });
      throw error;
    }
    await destination.close();

    const contentId = `sha256:${hash.digest('hex')}`;
    const path = this.#blobPath(contentId);
    const existing = this.#database.prepare('select content_id from blobs where content_id = ?').get(contentId);
    if (existing) {
      await rm(incoming, { force: true });
      return { contentId, bytes: source.size };
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await rename(incoming, path);
    this.#database.prepare(
      'insert into blobs(content_id, bytes, kind, created_at) values (?, ?, ?, ?)',
    ).run(contentId, source.size, kind, new Date().toISOString());
    return { contentId, bytes: source.size };
  }

  async getBlob(contentId: string): Promise<Buffer> {
    const envelope = await readFile(this.#blobPath(contentId));
    if (envelope[0] !== BLOB_VERSION || envelope.length < 29) throw new Error('Unsupported or corrupt vault blob.');
    const nonce = envelope.subarray(1, 13);
    const tag = envelope.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
    const actual = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
    if (actual !== contentId) throw new Error('Vault content hash mismatch.');
    return plaintext;
  }

  #assertSetupJournalDurability(): void {
    const transaction = this.#database.isTransaction;
    if (transaction !== false) throw new Error(transaction === true
      ? 'setup_operation_transaction_active' : 'setup_operation_durability_unqualified');
    const row = this.#database.prepare('pragma synchronous').get() as {synchronous: number};
    if (!row || !Number.isInteger(row.synchronous) || row.synchronous < 2 || row.synchronous > 3) {
      throw new Error('setup_operation_durability_unqualified');
    }
  }

  #decodeCodexSetupResult(row: CodexSetupRow): LocalCodexSetupResult {
    try {
      if (row.state !== 'terminal' || !row.nonce || !row.tag || !row.ciphertext) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, row.nonce);
      decipher.setAAD(Buffer.from(canonicalize({operationId: row.operation_id,
        intentDigest: row.intent_digest, state: 'terminal'})));
      decipher.setAuthTag(row.tag);
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
      return parseCodexSetupResult(value);
    } catch {throw new Error('setup_operation_integrity_failed');}
  }

  claimCodexSetupOperation(operationId: string, intentDigest: string): LocalCodexSetupClaim {
    if (typeof operationId !== 'string' || !setupId.test(operationId)
      || typeof intentDigest !== 'string' || !setupDigest.test(intentDigest)) throw new Error('setup_operation_invalid');
    this.#assertSetupJournalDurability();
    const leaseId = randomUUID();
    const leaseHash = createHash('sha256').update(`codex-setup-lease\0${leaseId}`).digest('hex');
    const inserted = this.#database.prepare(`insert into codex_setup_operations
      (operation_id, intent_digest, lease_hash, state) values (?, ?, ?, 'running')
      on conflict(operation_id) do nothing`).run(operationId, intentDigest, leaseHash);
    if (Number(inserted.changes) === 1) return {state: 'acquired', leaseId, intentDigest};
    const row = this.#database.prepare('select * from codex_setup_operations where operation_id = ?')
      .get(operationId) as unknown as CodexSetupRow | undefined;
    if (!row || row.intent_digest !== intentDigest) throw new Error('setup_operation_conflict');
    if (row.state === 'running') return {state: 'running', intentDigest};
    return {state: 'terminal', intentDigest, result: this.#decodeCodexSetupResult(row)};
  }

  finishCodexSetupOperation(leaseId: string, intentDigest: string, result: LocalCodexSetupResult): void {
    if (typeof leaseId !== 'string' || !setupId.test(leaseId)
      || typeof intentDigest !== 'string' || !setupDigest.test(intentDigest)) throw new Error('setup_operation_invalid');
    const accepted = parseCodexSetupResult(result); this.#assertSetupJournalDurability();
    const leaseHash = createHash('sha256').update(`codex-setup-lease\0${leaseId}`).digest('hex');
    const row = this.#database.prepare('select * from codex_setup_operations where lease_hash = ? and intent_digest = ?')
      .get(leaseHash, intentDigest) as unknown as CodexSetupRow | undefined;
    if (!row) throw new Error('setup_operation_conflict');
    if (row.state === 'terminal') {
      if (canonicalize(this.#decodeCodexSetupResult(row)) !== canonicalize(accepted)) throw new Error('setup_operation_conflict');
      return;
    }
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    cipher.setAAD(Buffer.from(canonicalize({operationId: row.operation_id, intentDigest, state: 'terminal'})));
    const ciphertext = Buffer.concat([cipher.update(canonicalize(accepted)), cipher.final()]);
    const changed = this.#database.prepare(`update codex_setup_operations set
      state = 'terminal', nonce = ?, tag = ?, ciphertext = ?
      where operation_id = ? and lease_hash = ? and intent_digest = ? and state = 'running'`)
      .run(nonce, cipher.getAuthTag(), ciphertext, row.operation_id, leaseHash, intentDigest);
    if (Number(changed.changes) !== 1) {
      const current = this.#database.prepare('select * from codex_setup_operations where operation_id = ?')
        .get(row.operation_id) as unknown as CodexSetupRow;
      if (!current || current.state !== 'terminal'
        || canonicalize(this.#decodeCodexSetupResult(current)) !== canonicalize(accepted)) throw new Error('setup_operation_conflict');
    }
  }

  #readProviderSessionBinding(bindingId: string): LocalProviderSessionBinding | null {
    const row = this.#database.prepare(`
      select session_locator_hash, nonce, tag, ciphertext, revoked_at
      from provider_session_bindings where binding_id = ?
    `).get(bindingId) as {
      session_locator_hash: string; nonce: Uint8Array; tag: Uint8Array;
      ciphertext: Uint8Array; revoked_at: string | null;
    } | undefined;
    if (!row || row.revoked_at) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, row.nonce);
    decipher.setAuthTag(row.tag);
    const record: unknown = JSON.parse(Buffer.concat([
      decipher.update(row.ciphertext), decipher.final(),
    ]).toString('utf8'));
    assertLocalProviderSessionBinding(record);
    const locatorHash = createHash('sha256')
      .update(`${record.provider}\u0000${record.sessionId}`).digest('hex');
    if (record.bindingId !== bindingId || row.session_locator_hash !== locatorHash) {
      throw new Error('provider_session_binding_integrity_failed');
    }
    return record;
  }

  saveProviderSessionBinding(record: LocalProviderSessionBinding): void {
    assertLocalProviderSessionBinding(record);
    if (Date.now() >= Date.parse(record.expiresAt)) throw new Error('provider_session_binding_expired');
    const existing = this.#readProviderSessionBinding(record.bindingId);
    if (existing) {
      if (canonicalize(existing) === canonicalize(record)) return;
      throw new Error('provider_session_binding_conflict');
    }
    const plaintext = Buffer.from(canonicalize(record), 'utf8');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const locatorHash = createHash('sha256')
      .update(`${record.provider}\u0000${record.sessionId}`).digest('hex');
    try {
      this.#database.prepare(`
        insert into provider_session_bindings
          (binding_id, session_locator_hash, nonce, tag, ciphertext, revoked_at)
        values (?, ?, ?, ?, ?, null)
      `).run(record.bindingId, locatorHash, nonce, cipher.getAuthTag(), ciphertext);
    } catch (error) {
      const collision = this.#database.prepare(`
        select binding_id from provider_session_bindings
        where binding_id = ? or session_locator_hash = ? limit 1
      `).get(record.bindingId, locatorHash);
      if (!collision) throw error;
      const concurrent = this.#readProviderSessionBinding(record.bindingId);
      if (concurrent && canonicalize(concurrent) === canonicalize(record)) return;
      throw new Error('provider_session_binding_conflict');
    }
  }

  getProviderSessionBinding(bindingId: string, expected: LocalProviderSessionIdentity): LocalProviderSessionBinding | null {
    const record = this.#readProviderSessionBinding(bindingId);
    if (!record) return null;
    if (!sameLocalProviderSessionIdentity(record, expected)) {
      throw new Error('provider_session_binding_scope_mismatch');
    }
    return record;
  }

  revokeProviderSessionBinding(bindingId: string, expected: LocalProviderSessionIdentity): void {
    const record = this.getProviderSessionBinding(bindingId, expected);
    if (!record) return;
    this.#database.prepare(`
      update provider_session_bindings set revoked_at = ? where binding_id = ? and revoked_at is null
    `).run(new Date().toISOString(), bindingId);
  }

  // Call only after verifying current enrollment, standing policy and remote ownership.
  // This renews a local execution deadline, never a signing key or enrollment anchor.
  renewProviderSessionBinding(bindingId: string, expected: LocalProviderSessionIdentity,
    expectedExpiresAt: string, expiresAt: string, now = new Date()): LocalProviderSessionBinding {
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(expiresAt))
      || Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) > now.getTime() + 30 * 86400000) {
      throw new Error('provider_session_binding_renewal_invalid');
    }
    this.#database.exec('begin immediate');
    try {
      const record = this.getProviderSessionBinding(bindingId, expected);
      if (!record || record.owner !== 'dharma_bridge') throw new Error('provider_session_binding_unavailable');
      if (record.expiresAt !== expectedExpiresAt || Date.parse(expiresAt) <= Date.parse(record.expiresAt)) {
        throw new Error('provider_session_binding_renewal_conflict');
      }
      const lease = this.#database.prepare('select host_name, owner_pid from provider_session_leases where binding_id = ?')
        .get(bindingId) as { host_name: string; owner_pid: number } | undefined;
      if (lease && (lease.host_name !== hostname() || (lease.owner_pid !== process.pid && processIsAlive(lease.owner_pid)))) {
        throw new Error('provider_session_lease_unavailable');
      }
      const next = { ...record, expiresAt }; assertLocalProviderSessionBinding(next);
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalize(next))), cipher.final()]);
      this.#database.prepare(`insert into provider_session_binding_renewals
        (binding_id, previous_expires_at, nonce, tag, ciphertext, renewed_at)
        select binding_id, ?, nonce, tag, ciphertext, ? from provider_session_bindings where binding_id = ?`)
        .run(record.expiresAt, now.toISOString(), bindingId);
      this.#database.prepare('update provider_session_bindings set nonce = ?, tag = ?, ciphertext = ? where binding_id = ? and revoked_at is null')
        .run(nonce, cipher.getAuthTag(), ciphertext, bindingId);
      this.#database.exec('commit'); return next;
    } catch (error) { this.#database.exec('rollback'); throw error; }
  }

  tryAcquireProviderSessionLease(
    bindingId: string, expected: LocalProviderSessionIdentity,
  ): LocalProviderSessionLease | null {
    const record = this.getProviderSessionBinding(bindingId, expected);
    if (!record || Date.now() >= Date.parse(record.expiresAt)) return null;
    const holderId = randomUUID();
    const currentHost = hostname();
    this.#database.exec('begin immediate');
    try {
      const current = this.#database.prepare(`
        select revoked_at from provider_session_bindings where binding_id = ?
      `).get(bindingId) as { revoked_at: string | null } | undefined;
      if (!current || current.revoked_at || Date.now() >= Date.parse(record.expiresAt)) {
        this.#database.exec('commit');
        return null;
      }
      const prior = this.#database.prepare(`
        select host_name, owner_pid from provider_session_leases where binding_id = ?
      `).get(bindingId) as { host_name: string; owner_pid: number } | undefined;
      if (prior && (prior.host_name !== currentHost || processIsAlive(prior.owner_pid))) {
        this.#database.exec('commit');
        return null;
      }
      this.#database.prepare(`
        insert into provider_session_leases (binding_id, holder_id, host_name, owner_pid, acquired_at)
        values (?, ?, ?, ?, ?)
        on conflict(binding_id) do update set holder_id = excluded.holder_id,
          host_name = excluded.host_name, owner_pid = excluded.owner_pid,
          acquired_at = excluded.acquired_at
      `).run(bindingId, holderId, currentHost, process.pid, new Date().toISOString());
      this.#database.exec('commit');
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      throw error;
    }
    return {
      assertHeld: async () => {
        const active = this.getProviderSessionBinding(bindingId, expected);
        if (!active || Date.now() >= Date.parse(active.expiresAt)) return false;
        const row = this.#database.prepare(`
          select holder_id, host_name, owner_pid from provider_session_leases where binding_id = ?
        `).get(bindingId) as { holder_id: string; host_name: string; owner_pid: number } | undefined;
        return row?.holder_id === holderId && row.host_name === currentHost && row.owner_pid === process.pid;
      },
      release: () => {
        this.#database.prepare(`
          delete from provider_session_leases where binding_id = ? and holder_id = ?
        `).run(bindingId, holderId);
      },
    };
  }

  recordSession(input: {
    sessionId: string; provider: string; workspaceId: string;
    sourceLocator: string; status: string; observedAt: string;
  }): void {
    const locatorHash = createHash('sha256').update(input.sourceLocator).digest('hex');
    this.#database.prepare(`
      insert into sessions(session_id, provider, workspace_id, source_locator_hash, status, observed_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(session_id) do update set status = excluded.status, observed_at = excluded.observed_at
    `).run(input.sessionId, input.provider, input.workspaceId, locatorHash, input.status, input.observedAt);
  }

  recordCapsule(trajectoryId: string, revision: number, capsuleHash: string, blobContentId: string): void {
    const result = this.#database.prepare(`
      insert into capsules(trajectory_id, revision, capsule_hash, blob_content_id, created_at)
      values (?, ?, ?, ?, ?)
      on conflict(trajectory_id, revision) do nothing
    `).run(trajectoryId, revision, capsuleHash, blobContentId, new Date().toISOString());
    if (result.changes > 0) return;
    const existing = this.#database.prepare(`
      select capsule_hash from capsules where trajectory_id = ? and revision = ?
    `).get(trajectoryId, revision) as { capsule_hash: string } | undefined;
    if (existing?.capsule_hash !== capsuleHash) {
      throw new Error('Trajectory capsule revision hash conflict.');
    }
  }

  getLatestCapsuleMetadata(trajectoryId: string): {
    revision: number;
    capsuleHash: string;
    blobContentId: string;
  } | null {
    const record = this.#database.prepare(`
      select revision, capsule_hash, blob_content_id
      from capsules where trajectory_id = ? order by revision desc limit 1
    `).get(trajectoryId) as { revision: number; capsule_hash: string; blob_content_id: string } | undefined;
    return record ? {
      revision: record.revision,
      capsuleHash: record.capsule_hash,
      blobContentId: record.blob_content_id,
    } : null;
  }

  getCapsuleMetadata(trajectoryId: string, revision: number): {
    revision: number;
    capsuleHash: string;
    blobContentId: string;
  } | null {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Trajectory capsule revision must be a positive integer.');
    }
    const record = this.#database.prepare(`
      select revision, capsule_hash, blob_content_id
      from capsules where trajectory_id = ? and revision = ?
    `).get(trajectoryId, revision) as { revision: number; capsule_hash: string; blob_content_id: string } | undefined;
    return record ? {
      revision: record.revision,
      capsuleHash: record.capsule_hash,
      blobContentId: record.blob_content_id,
    } : null;
  }

  async commitCapture(input: VaultCaptureInput): Promise<{ rawContentId: string; capsuleContentId: string }> {
    const created = new Set<string>();
    this.#database.exec('begin immediate');
    try {
      const raw = await this.#putBlob(input.raw.plaintext, input.raw.kind);
      if (raw.contentId !== input.raw.expectedContentId) throw new Error('Raw evidence content hash changed before vault commit.');
      if (raw.created) created.add(raw.contentId);
      const capsule = await this.#putBlob(input.capsule.plaintext, 'trajectory-capsule');
      if (capsule.created) created.add(capsule.contentId);
      this.recordSession(input.session);
      this.recordCapsule(
        input.capsule.trajectoryId,
        input.capsule.revision,
        input.capsule.capsuleHash,
        capsule.contentId,
      );
      this.#recordCapsuleContentRefs(
        input.capsule.trajectoryId,
        input.capsule.revision,
        JSON.parse(Buffer.from(input.capsule.plaintext).toString('utf8')) as Record<string, unknown>,
      );
      this.#database.exec('commit');
      return { rawContentId: raw.contentId, capsuleContentId: capsule.contentId };
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      await Promise.all([...created].map((contentId) => rm(this.#blobPath(contentId), { force: true })));
      throw error;
    }
  }

  async getLatestCapsule<T = Record<string, unknown>>(trajectoryId: string): Promise<T> {
    const record = this.#database.prepare(`
      select blob_content_id from capsules where trajectory_id = ? order by revision desc limit 1
    `).get(trajectoryId) as { blob_content_id: string } | undefined;
    if (!record) throw new Error('Trajectory capsule is not available in the local vault.');
    return JSON.parse((await this.getBlob(record.blob_content_id)).toString('utf8')) as T;
  }

  async getCapsule<T = Record<string, unknown>>(trajectoryId: string, revision: number): Promise<T> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Trajectory capsule revision must be a positive integer.');
    }
    const record = this.#database.prepare(`
      select blob_content_id from capsules where trajectory_id = ? and revision = ?
    `).get(trajectoryId, revision) as { blob_content_id: string } | undefined;
    if (!record) throw new Error('Trajectory capsule revision is not available in the local vault.');
    return JSON.parse((await this.getBlob(record.blob_content_id)).toString('utf8')) as T;
  }

  async discardCapsuleRevisionsAfter(trajectoryId: string, acceptedRevision: number): Promise<number> {
    if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision < 0) {
      throw new Error('Accepted trajectory revision must be a non-negative integer.');
    }
    const rows = this.#database.prepare(`
      select revision, blob_content_id from capsules
      where trajectory_id = ? and revision > ? order by revision asc
    `).all(trajectoryId, acceptedRevision) as Array<{ revision: number; blob_content_id: string }>;
    if (rows.length === 0) return 0;
    this.#database.exec('begin immediate');
    try {
      this.#database.prepare('delete from capsule_sync_queue where trajectory_id = ? and revision > ?')
        .run(trajectoryId, acceptedRevision);
      this.#database.prepare('delete from capsule_sync_failures where trajectory_id = ? and revision > ?')
        .run(trajectoryId, acceptedRevision);
      this.#database.prepare('delete from capsule_content_refs where trajectory_id = ? and revision > ?')
        .run(trajectoryId, acceptedRevision);
      this.#database.prepare('delete from capsules where trajectory_id = ? and revision > ?')
        .run(trajectoryId, acceptedRevision);
      this.#database.exec('commit');
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      throw error;
    }
    for (const row of rows) {
      const referenced = this.#database.prepare('select 1 from capsules where blob_content_id = ? limit 1')
        .get(row.blob_content_id);
      if (referenced) continue;
      this.#database.prepare('delete from blobs where content_id = ? and kind = ?')
        .run(row.blob_content_id, 'trajectory-capsule');
      await rm(this.#blobPath(row.blob_content_id), { force: true });
    }
    return rows.length;
  }

  async listPendingCapsuleSyncs<T = Record<string, unknown>>(limit = 100, offset = 0): Promise<Array<{
    trajectoryId: string;
    revision: number;
    capsule: T;
  }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Pending capsule sync limit must be between 1 and 1000.');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Pending capsule sync offset is invalid.');
    const records = this.#database.prepare(`
      select trajectory_id, revision, blob_content_id
      from capsule_sync_queue
      order by created_at asc, trajectory_id asc, revision asc
      limit ? offset ?
    `).all(limit, offset) as Array<{ trajectory_id: string; revision: number; blob_content_id: string }>;
    return Promise.all(records.map(async (record) => ({
      trajectoryId: record.trajectory_id,
      revision: record.revision,
      capsule: JSON.parse((await this.getBlob(record.blob_content_id)).toString('utf8')) as T,
    })));
  }

  queueCapsuleSync(trajectoryId: string, revision: number): void {
    if (!trajectoryId || !Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Pending capsule sync identity is invalid.');
    }
    const capsule = this.#database.prepare(`
      select blob_content_id from capsules where trajectory_id = ? and revision = ?
    `).get(trajectoryId, revision) as { blob_content_id: string } | undefined;
    if (!capsule) throw new Error('Pending capsule sync is not available in the local vault.');
    this.#database.prepare(`
      insert into capsule_sync_queue(trajectory_id, revision, blob_content_id, created_at)
      values (?, ?, ?, ?)
      on conflict(trajectory_id, revision) do nothing
    `).run(trajectoryId, revision, capsule.blob_content_id, new Date().toISOString());
  }

  markCapsuleSynced(trajectoryId: string, revision: number): void {
    this.#database.prepare(`
      delete from capsule_sync_queue where trajectory_id = ? and revision = ?
    `).run(trajectoryId, revision);
  }

  discardPendingCapsuleSync(trajectoryId: string, revision: number, reason = 'authorization_revoked'): void {
    if (!reason || reason.length > 120) throw new Error('Capsule sync failure reason is invalid.');
    this.#database.exec('begin immediate');
    try {
      this.#database.prepare(`
        insert into capsule_sync_failures(trajectory_id, revision, reason, recorded_at)
        values (?, ?, ?, ?)
        on conflict(trajectory_id, revision) do update set reason = excluded.reason, recorded_at = excluded.recorded_at
      `).run(trajectoryId, revision, reason, new Date().toISOString());
      this.#database.prepare(`
        delete from capsule_sync_queue where trajectory_id = ? and revision = ?
      `).run(trajectoryId, revision);
      this.#database.exec('commit');
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      throw error;
    }
  }

  recordDisclosure(disclosureId: string, receiptHash: string, bytesUploaded: number): void {
    if (!/^sha256:[a-f0-9]{64}$/.test(receiptHash) || !Number.isSafeInteger(bytesUploaded) || bytesUploaded < 0) {
      throw new Error('Disclosure receipt is invalid.');
    }
    this.#database.prepare(`
      insert into disclosures(disclosure_id, receipt_hash, bytes_uploaded, created_at)
      values (?, ?, ?, ?)
      on conflict(disclosure_id) do update set
        receipt_hash = excluded.receipt_hash,
        bytes_uploaded = excluded.bytes_uploaded
    `).run(disclosureId, receiptHash, bytesUploaded, new Date().toISOString());
  }

  async stageTaskCompletionRecovery(taskId: string, plaintext: Uint8Array): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId) || plaintext.byteLength < 1) {
      throw new Error('Task completion recovery payload is invalid.');
    }
    const existing = this.#database.prepare(`
      select blob_content_id from task_completion_recovery where task_id = ?
    `).get(taskId) as { blob_content_id: string } | undefined;
    if (existing) {
      const expected = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
      if (existing.blob_content_id !== expected) {
        throw new Error('Task completion recovery payload changed after it was staged.');
      }
      return existing.blob_content_id;
    }
    const blob = await this.#putBlob(plaintext, 'task-completion-recovery');
    try {
      this.#database.prepare(`
        insert into task_completion_recovery(task_id, blob_content_id, created_at)
        values (?, ?, ?)
      `).run(taskId, blob.contentId, new Date().toISOString());
      return blob.contentId;
    } catch (error) {
      if (blob.created) {
        await rm(this.#blobPath(blob.contentId), { force: true });
        this.#database.prepare('delete from blobs where content_id = ?').run(blob.contentId);
      }
      throw error;
    }
  }

  async getTaskCompletionRecovery<T = Record<string, unknown>>(taskId: string): Promise<T | null> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error('Task completion recovery identity is invalid.');
    const record = this.#database.prepare(`
      select blob_content_id from task_completion_recovery where task_id = ?
    `).get(taskId) as { blob_content_id: string } | undefined;
    if (!record) return null;
    return JSON.parse((await this.getBlob(record.blob_content_id)).toString('utf8')) as T;
  }

  async clearTaskCompletionRecovery(taskId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error('Task completion recovery identity is invalid.');
    const record = this.#database.prepare(`
      select blob_content_id from task_completion_recovery where task_id = ?
    `).get(taskId) as { blob_content_id: string } | undefined;
    if (!record) return;
    let deletedBlob = false;
    this.#database.exec('begin immediate');
    try {
      this.#database.prepare('delete from task_completion_recovery where task_id = ?').run(taskId);
      const retained = this.#database.prepare(`
        select 1 where exists (
          select 1 from task_completion_recovery where blob_content_id = ?
        ) or exists (
          select 1 from capsules where blob_content_id = ?
        ) or exists (
          select 1 from capsule_sync_queue where blob_content_id = ?
        ) or exists (
          select 1 from capsule_content_refs where content_id = ? and available_locally = 1
        )
      `).get(record.blob_content_id, record.blob_content_id, record.blob_content_id, record.blob_content_id);
      if (!retained) {
        const deleted = this.#database.prepare(`
          delete from blobs where content_id = ? and kind = 'task-completion-recovery'
        `).run(record.blob_content_id);
        deletedBlob = deleted.changes === 1;
      }
      this.#database.exec('commit');
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      throw error;
    }
    if (deletedBlob) await rm(this.#blobPath(record.blob_content_id), { force: true });
  }

  listSessions(): unknown[] {
    return this.#database.prepare(`
      select session_id, provider, workspace_id, status, observed_at from sessions order by observed_at desc
    `).all();
  }

  stats(): { blobs: number; sessions: number; capsules: number } {
    const count = (table: 'blobs' | 'sessions' | 'capsules') => {
      const row = this.#database.prepare(`select count(*) as count from ${table}`).get() as { count: number };
      return row.count;
    };
    return { blobs: count('blobs'), sessions: count('sessions'), capsules: count('capsules') };
  }

  async enforceRawEvidenceRetention(input: {
    retentionDays?: number;
    now?: Date;
    limit?: number;
  } = {}): Promise<{ examined: number; deleted: number; cutoff: string }> {
    const retentionDays = input.retentionDays ?? 30;
    const limit = input.limit ?? 10_000;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
      throw new Error('Raw evidence retention must be between 1 and 3650 days.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Raw evidence retention limit must be between 1 and 10000.');
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('Raw evidence retention time is invalid.');
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    await this.#recoverUnindexedBlobs();
    await this.#backfillCapsuleContentRefs();
    let examined = 0;
    let deleted = 0;
    for (;;) {
      const expired = this.#database.prepare(`
        select content_id
        from blobs
        where kind in ('raw-provider-turn', 'raw-provider-session')
          and created_at < ?
          and not exists (
            select 1 from capsules where capsules.blob_content_id = blobs.content_id
          )
        order by created_at asc, content_id asc
        limit ?
      `).all(cutoff, limit) as Array<{ content_id: string }>;
      if (expired.length === 0) break;
      examined += expired.length;
      await this.#expireRawEvidenceBatch(expired.map((row) => row.content_id), now.toISOString());
      deleted += expired.length;
    }
    return { examined, deleted, cutoff };
  }

  close(): void {
    this.#database.close();
  }

  #blobPath(contentId: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(contentId)) throw new Error('Invalid content ID.');
    const digest = contentId.slice('sha256:'.length);
    return resolve(this.root, 'blobs', digest.slice(0, 2), `${digest}.blob`);
  }

  async #expireRawEvidenceBatch(contentIds: string[], createdAt: string): Promise<void> {
    const quarantined: Array<{ original: string; quarantine: string }> = [];
    const createdCapsuleIds = new Set<string>();
    this.#database.exec('begin immediate');
    try {
      for (const contentId of contentIds) {
        const original = this.#blobPath(contentId);
        const quarantine = `${original}.expired-${process.pid}-${randomBytes(4).toString('hex')}`;
        await rename(original, quarantine);
        quarantined.push({ original, quarantine });

        const capsuleRows = this.#database.prepare(`
          select c.trajectory_id, c.revision, c.capsule_hash, c.blob_content_id
          from capsules c
          join capsule_content_refs refs
            on refs.trajectory_id = c.trajectory_id and refs.revision = c.revision
          where c.revision = (
            select max(latest.revision) from capsules latest where latest.trajectory_id = c.trajectory_id
          )
            and refs.content_id = ?
            and refs.available_locally = 1
          order by c.trajectory_id asc
        `).all(contentId) as Array<{
          trajectory_id: string;
          revision: number;
          capsule_hash: string;
          blob_content_id: string;
        }>;
        for (const row of capsuleRows) {
          const current = JSON.parse((await this.getBlob(row.blob_content_id)).toString('utf8')) as Record<string, unknown>;
          const contentIndex = Array.isArray(current.contentIndex) ? current.contentIndex : [];
          const referencesExpired = contentIndex.some((item) => item && typeof item === 'object'
            && !Array.isArray(item) && (item as Record<string, unknown>).contentId === contentId
            && (item as Record<string, unknown>).availableLocally === true);
          if (!referencesExpired) continue;
          const nextBase = {
            ...current,
            revision: row.revision + 1,
            previousRevisionHash: row.capsule_hash,
            contentIndex: contentIndex.map((item) => item && typeof item === 'object' && !Array.isArray(item)
              && (item as Record<string, unknown>).contentId === contentId
              ? { ...(item as Record<string, unknown>), availableLocally: false }
              : item),
            localEvidenceAvailable: Array.isArray(current.localEvidenceAvailable)
              ? current.localEvidenceAvailable.filter((item) => !item || typeof item !== 'object'
                || Array.isArray(item) || (item as Record<string, unknown>).contentId !== contentId)
              : [],
            createdAt,
          } as Record<string, unknown>;
          delete nextBase.capsuleHash;
          const revised = { ...nextBase, capsuleHash: trajectoryCapsuleHash(nextBase as never) };
          const capsuleBlob = await this.#putBlob(Buffer.from(JSON.stringify(revised)), 'trajectory-capsule');
          if (capsuleBlob.created) createdCapsuleIds.add(capsuleBlob.contentId);
          this.recordCapsule(row.trajectory_id, row.revision + 1, revised.capsuleHash, capsuleBlob.contentId);
          this.#recordCapsuleContentRefs(row.trajectory_id, row.revision + 1, revised);
          this.#database.prepare(`
            insert into capsule_sync_queue(trajectory_id, revision, blob_content_id, created_at)
            values (?, ?, ?, ?)
            on conflict(trajectory_id, revision) do nothing
          `).run(row.trajectory_id, row.revision + 1, capsuleBlob.contentId, createdAt);
        }

        const result = this.#database.prepare(`
          delete from blobs
          where content_id = ?
            and kind in ('raw-provider-turn', 'raw-provider-session')
            and not exists (
              select 1 from capsules where capsules.blob_content_id = blobs.content_id
            )
        `).run(contentId);
        if (result.changes !== 1) throw new Error('Raw evidence changed during retention enforcement.');
      }
      this.#database.exec('commit');
      await Promise.all(quarantined.map((entry) => rm(entry.quarantine, { force: true })));
    } catch (error) {
      try { this.#database.exec('rollback'); } catch {}
      await Promise.all([...createdCapsuleIds].map((contentId) => rm(this.#blobPath(contentId), { force: true })));
      await Promise.all(quarantined.map(async (entry) => {
        try { await rename(entry.quarantine, entry.original); } catch {}
      }));
      throw error;
    }
  }

  #recordCapsuleContentRefs(trajectoryId: string, revision: number, capsule: Record<string, unknown>): void {
    const contentIndex = Array.isArray(capsule.contentIndex) ? capsule.contentIndex : [];
    const insert = this.#database.prepare(`
      insert into capsule_content_refs(trajectory_id, revision, content_id, available_locally)
      values (?, ?, ?, ?)
      on conflict(trajectory_id, revision, content_id) do update set
        available_locally = excluded.available_locally
    `);
    for (const item of contentIndex) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.contentId !== 'string') continue;
      insert.run(trajectoryId, revision, record.contentId, record.availableLocally === true ? 1 : 0);
    }
  }

  async #backfillCapsuleContentRefs(): Promise<void> {
    const records = this.#database.prepare(`
      select c.trajectory_id, c.revision, c.blob_content_id
      from capsules c
      where not exists (
        select 1 from capsule_content_refs refs
        where refs.trajectory_id = c.trajectory_id and refs.revision = c.revision
      )
      order by c.trajectory_id asc, c.revision asc
    `).all() as Array<{ trajectory_id: string; revision: number; blob_content_id: string }>;
    for (const record of records) {
      const capsule = JSON.parse((await this.getBlob(record.blob_content_id)).toString('utf8')) as Record<string, unknown>;
      this.#recordCapsuleContentRefs(record.trajectory_id, record.revision, capsule);
    }
  }

  async #recoverUnindexedBlobs(): Promise<void> {
    const blobsRoot = resolve(this.root, 'blobs');
    for (const prefix of await readdir(blobsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = resolve(blobsRoot, prefix.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const final = /^([a-f0-9]{64})\.blob$/.exec(entry.name);
        const temporary = /^([a-f0-9]{64})\.blob\.([1-9][0-9]*)\.[a-f0-9]{8}\.tmp$/.exec(entry.name);
        if (!entry.isFile() || (!final && !temporary)) continue;
        const digest = (final ?? temporary)![1]!;
        if (digest.slice(0, 2) !== prefix.name) continue;
        if (temporary && processIsAlive(Number(temporary[2]))) continue;
        const path = resolve(directory, entry.name);
        // Final publication uses this same SQLite write fence. Recheck metadata
        // and unlink without yielding so a concurrent commit cannot lose its blob.
        this.#database.exec('begin immediate');
        try {
          const retained = final && this.#database.prepare('select 1 from blobs where content_id = ?').get(`sha256:${digest}`);
          if (!retained) {
            try { if (lstatSync(path).isFile()) unlinkSync(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          this.#database.exec('commit');
        } catch (error) { this.#database.exec('rollback'); throw error; }
      }
    }
  }

  async #recoverRetentionQuarantine(): Promise<void> {
    const blobsRoot = resolve(this.root, 'blobs');
    const prefixes = await readdir(blobsRoot, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = resolve(blobsRoot, prefix.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.blob\.expired-/.test(entry.name)) continue;
        const quarantine = resolve(directory, entry.name);
        const original = resolve(directory, entry.name.replace(/\.expired-.+$/, ''));
        const digest = basename(original, '.blob');
        const contentId = `sha256:${digest}`;
        const retained = this.#database.prepare('select 1 from blobs where content_id = ?').get(contentId);
        if (retained) {
          try { await rename(quarantine, original); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') await rm(quarantine, { force: true });
            else throw error;
          }
        } else {
          await rm(quarantine, { force: true });
        }
      }
    }
  }
}

export function loadExplicitTestKey(env: NodeJS.ProcessEnv): Buffer {
  if (env.DHARMA_ALLOW_ENV_KEY !== '1' || !env.DHARMA_VAULT_KEY) {
    throw new Error('No secure operating-system key store is configured.');
  }
  const key = Buffer.from(env.DHARMA_VAULT_KEY, 'base64');
  if (key.length !== 32) throw new Error('DHARMA_VAULT_KEY must be a base64-encoded 32-byte key.');
  return key;
}

export async function loadOrCreateVaultMasterKey(store?: SecureSecretStore): Promise<Buffer> {
  if (process.env.DHARMA_ALLOW_ENV_KEY === '1') return loadExplicitTestKey(process.env);
  const secureStore = store ?? await createSystemSecureStore();
  const account = 'vault-master-key-v1';
  const current = await secureStore.get(account);
  if (current) {
    const key = Buffer.from(current, 'base64');
    if (key.length !== 32) throw new Error('Stored vault master key is corrupt.');
    return key;
  }
  const key = randomBytes(32);
  await secureStore.put(account, key.toString('base64'));
  const confirmed = await secureStore.get(account);
  if (confirmed !== key.toString('base64')) throw new Error('Secure store did not confirm the vault key write.');
  return key;
}
