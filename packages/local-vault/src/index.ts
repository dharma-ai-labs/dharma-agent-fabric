import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai/agent-fabric-secure-store';

const BLOB_VERSION = 1;

export interface VaultOptions {
  root: string;
  masterKey: Buffer;
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
    `);
    return new LocalVault(options, database);
  }

  async putBlob(plaintext: Uint8Array, kind: string): Promise<string> {
    const contentId = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
    const path = this.#blobPath(contentId);
    const existing = this.#database.prepare('select content_id from blobs where content_id = ?').get(contentId);
    if (existing) return contentId;

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([Buffer.from([BLOB_VERSION]), nonce, tag, ciphertext]);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    this.#database.prepare(
      'insert into blobs(content_id, bytes, kind, created_at) values (?, ?, ?, ?)',
    ).run(contentId, plaintext.byteLength, kind, new Date().toISOString());
    return contentId;
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
    this.#database.prepare(`
      insert into capsules(trajectory_id, revision, capsule_hash, blob_content_id, created_at)
      values (?, ?, ?, ?, ?)
    `).run(trajectoryId, revision, capsuleHash, blobContentId, new Date().toISOString());
  }

  listSessions(): unknown[] {
    return this.#database.prepare(`
      select session_id, provider, workspace_id, status, observed_at from sessions order by observed_at desc
    `).all();
  }

  close(): void {
    this.#database.close();
  }

  #blobPath(contentId: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(contentId)) throw new Error('Invalid content ID.');
    const digest = contentId.slice('sha256:'.length);
    return resolve(this.root, 'blobs', digest.slice(0, 2), `${digest}.blob`);
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
