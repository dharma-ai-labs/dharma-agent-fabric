import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
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
      create index if not exists blobs_raw_retention_idx on blobs(kind, created_at, content_id);
      create index if not exists capsules_blob_content_id_idx on capsules(blob_content_id);
      create index if not exists capsules_latest_revision_idx on capsules(trajectory_id, revision desc);
      create index if not exists capsule_content_refs_lookup_idx
        on capsule_content_refs(content_id, available_locally, trajectory_id, revision);
    `);
    const vault = new LocalVault(options, database);
    await vault.#recoverRetentionQuarantine();
    await vault.#backfillCapsuleContentRefs();
    await vault.enforceRawEvidenceRetention({ retentionDays: options.rawLocalDays ?? 30 });
    return vault;
  }

  async #putBlob(plaintext: Uint8Array, kind: string): Promise<{ contentId: string; created: boolean }> {
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
    await rename(temporary, path);
    try {
      this.#database.prepare(
        'insert into blobs(content_id, bytes, kind, created_at) values (?, ?, ?, ?)',
      ).run(contentId, plaintext.byteLength, kind, new Date().toISOString());
      return { contentId, created: true };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async putBlob(plaintext: Uint8Array, kind: string): Promise<string> {
    return (await this.#putBlob(plaintext, kind)).contentId;
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
