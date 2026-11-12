import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  newSessionDeliveryReceipt,
  parseCodexQueueStdout,
  readSessionDeliveryReceipt,
  sessionDeliveryReceiptPath,
  writeSessionDeliveryReceipt,
} from './sessionDeliveryReceipt.js';

const THREAD = randomUUID();

test('one atomic JSON receipt per message id under session-messages/receipts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-receipt-'));
  try {
    const messageId = randomUUID();
    assert.equal(sessionDeliveryReceiptPath(home, messageId), join(home, 'session-messages', 'receipts', `${messageId}.json`));
    assert.equal(await readSessionDeliveryReceipt(home, messageId), null);
    const receipt = newSessionDeliveryReceipt({ messageId, recipientName: 'ef', threadId: THREAD,
      now: new Date('2026-11-10T12:00:00.000Z') });
    assert.equal(receipt.schema, 'dharma.session-delivery-receipt/v1');
    assert.equal(receipt.state, 'submitting');
    assert.equal(receipt.attempts, 0);
    assert.equal(receipt.queueId, null);
    assert.deepEqual(receipt.emptyReads, []);
    await writeSessionDeliveryReceipt(home, { ...receipt, attempts: 1 });
    assert.equal((await readSessionDeliveryReceipt(home, messageId))?.attempts, 1);
    assert.deepEqual(await readdir(join(home, 'session-messages', 'receipts')), [`${messageId}.json`]);
    assert.throws(() => sessionDeliveryReceiptPath(home, '../escape'), /session_message_id_invalid/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the queue id is read from stdout for the attached thread only', () => {
  const qid = '01a1c435-5aad-7a51-b8e3-1f2c3d4e5f60';
  assert.equal(parseCodexQueueStdout(`Queued message ${qid} for thread ${THREAD}.\n`, THREAD), qid);
  assert.equal(parseCodexQueueStdout(`warning: something\r\nQueued message ${qid} for thread ${THREAD}.\r\n`, THREAD), qid);
  assert.equal(parseCodexQueueStdout(`Queued message ${qid} for thread ${randomUUID()}.\n`, THREAD), null);
  assert.equal(parseCodexQueueStdout('', THREAD), null);
  assert.equal(parseCodexQueueStdout(`Queued message ${qid} for thread ${THREAD}`, THREAD), null, 'a truncated line is not an ACK');
  assert.equal(parseCodexQueueStdout(`Queued message $(rm -rf) for thread ${THREAD}.\n`, THREAD), null);
});
