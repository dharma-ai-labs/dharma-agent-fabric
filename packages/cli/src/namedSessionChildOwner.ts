import {AsyncLocalStorage} from 'node:async_hooks';
import type {ChildProcess} from 'node:child_process';
import {watchOwnedChild, type OwnedChildLifecycle} from './ownedChildLifecycle.js';

type Entry = {child: ChildProcess; lifecycle: OwnedChildLifecycle; stopping?: Promise<void>};
const context = new AsyncLocalStorage<NamedSessionChildOwner>();
const owners = new WeakMap<ChildProcess, NamedSessionChildOwner>();

export interface NamedSessionChildOwner {
  run<T>(operation: () => Promise<T>): Promise<T>;
  assert(): void;
  ownedPid(name: string): number | null;
  checkpoint(name: string): Readonly<{stopFresh(): Promise<void>}>;
  spawn(name: string, operation: () => ChildProcess): Promise<ChildProcess>;
  close(): Promise<void>;
}

/** Standing supervisor owns only handles returned by its own fresh spawns. */
export function createNamedSessionChildOwner(signal: AbortSignal): NamedSessionChildOwner {
  const children = new Map<string, Entry>();
  const pending = new Set<string>(), acquisitions = new Set<Promise<ChildProcess>>();
  let active = true, borrowed = false, closing: Promise<void> | undefined;
  const stop = (entry: Entry) => entry.lifecycle.stopped ? Promise.resolve() : entry.stopping ??= entry.lifecycle.stop();
  const abort = () => {
    active = false;
    for (const entry of children.values()) void stop(entry).catch(() => {});
  };
  const assertDispatch = () => {
    if (context.getStore() !== owner || !borrowed || !active || signal.aborted) {
      throw new Error('named_session_child_owner_unavailable');
    }
  };
  const owner: NamedSessionChildOwner = {
    assert: assertDispatch,
    checkpoint(name) {
      assertDispatch();
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error('named_session_child_owner_conflict');
      const previous = children.get(name);
      return Object.freeze({async stopFresh() {
        const entry = children.get(name);
        // Limited cooperative cleanup uses captured handles, never PID lookup.
        // Preserve any child that preceded this request and all sibling names.
        if (entry && entry !== previous) await stop(entry);
      }});
    },
    ownedPid(name) {
      assertDispatch();
      const entry = children.get(name);
      return entry && !entry.lifecycle.stopped && !entry.lifecycle.failed && !entry.stopping
        && Number.isSafeInteger(entry.child.pid) ? entry.child.pid! : null;
    },
    async run(operation) {
      if (context.getStore() || borrowed || !active || signal.aborted) throw new Error('named_session_child_owner_unavailable');
      borrowed = true;
      try {return await context.run(owner, operation);}
      finally {borrowed = false; await owner.close();}
    },
    spawn(name, operation) {
      const acquisition = (async () => {
        assertDispatch();
        if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || pending.has(name)) throw new Error('named_session_child_owner_conflict');
        pending.add(name);
        try {
          for (const [key, entry] of children) if (entry.lifecycle.stopped) children.delete(key);
          const prior = children.get(name);
          if (prior) {
            if (prior.lifecycle.failed || prior.stopping) await stop(prior);
            if (!prior.lifecycle.stopped) throw new Error('named_session_owned_child_still_running');
            children.delete(name);
          }
          if (children.size >= 50) throw new Error('named_session_child_owner_capacity');
          assertDispatch();
          const child = operation();
          // Capture before post-dispatch refusal, including synchronous abort.
          if (owners.has(child)) throw new Error('named_session_child_owner_conflict');
          const entry: Entry = {child, lifecycle: watchOwnedChild(child)};
          owners.set(child, owner); children.set(name, entry);
          if (!active || signal.aborted) void stop(entry).catch(() => {});
          assertDispatch();
          return child;
        } finally {pending.delete(name);}
      })();
      acquisitions.add(acquisition);
      void acquisition.then(() => acquisitions.delete(acquisition), () => acquisitions.delete(acquisition));
      return acquisition;
    },
    close() {
      active = false;
      signal.removeEventListener('abort', abort);
      return closing ??= (async () => {
        // Include a handle acquired while close was called inside its spawn.
        await Promise.allSettled([...acquisitions]);
        const results = await Promise.allSettled([...children.values()].map(stop));
        if (results.some(result => result.status === 'rejected')) throw new Error('owned_child_stop_unconfirmed');
      })();
    },
  };
  Object.freeze(owner);
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  return owner;
}

/** Internal caller composition; no adoption from PID files or inventories. */
export function currentNamedSessionChildOwner() {return context.getStore();}
