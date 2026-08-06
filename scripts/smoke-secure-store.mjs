import { randomBytes } from 'node:crypto';
import { createSystemSecureStore } from '../packages/secure-store/dist/index.js';

const store = await createSystemSecureStore();
const account = `integration-smoke-${process.pid}`;
const secret = randomBytes(24).toString('base64url');
let roundTrip = false;
let deleted = false;
try {
  await store.put(account, secret);
  roundTrip = await store.get(account) === secret;
} finally {
  await store.delete(account);
  deleted = await store.get(account) === null;
}
process.stdout.write(`${JSON.stringify({ backend: store.backend, roundTrip, deleted })}\n`);
if (!roundTrip || !deleted) process.exitCode = 1;
