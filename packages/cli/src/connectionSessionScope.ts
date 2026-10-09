import {AsyncLocalStorage} from 'node:async_hooks';

// Preserve isolation across the entire asynchronous bootstrap continuation,
// including nested onboarding and client factories. Concurrent calls do not
// borrow a sibling operation's durable protocol session or outbox.
const scope = new AsyncLocalStorage<boolean>();
export function isIsolatedDeviceSession(): boolean {return scope.getStore() === true;}
export function runInIsolatedDeviceSession<T>(operation: () => Promise<T>): Promise<T> {
  return scope.run(true, operation);
}
