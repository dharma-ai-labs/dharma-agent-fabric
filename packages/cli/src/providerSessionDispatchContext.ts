import { types } from 'node:util';

export interface ProviderSessionDispatchContext { signal?: AbortSignal; expiresAt?: string }

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

function invalid(): never {throw new Error('provider_session_dispatch_context_invalid');}

export function snapshotProviderSessionDispatchContext(value?: ProviderSessionDispatchContext): Readonly<ProviderSessionDispatchContext> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['signal', 'expiresAt'].includes(key))
    || Object.values(fields).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))) invalid();
  const signal = fields.signal?.value, expiresAt = fields.expiresAt?.value;
  if (signal !== undefined) {
    if (!signal || typeof signal !== 'object' || types.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(signal);
    if (Reflect.ownKeys(descriptors).some(key => !Object.hasOwn(descriptors[key as keyof typeof descriptors]!, 'value'))) invalid();
    try {signalAborted.call(signal);} catch {invalid();}
  }
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) invalid();
  // Detach the record, not the signal: later abortion of the original signal remains observable.
  return Object.freeze({...(signal === undefined ? {} : {signal}), ...(expiresAt === undefined ? {} : {expiresAt})});
}

export function requireProviderSessionDispatch(context?: Readonly<ProviderSessionDispatchContext>, time = Date.now()): void {
  if (context?.signal && signalAborted.call(context.signal)) throw new Error('provider_session_channel_cancelled');
  if (context?.expiresAt !== undefined && (!Number.isFinite(time) || time >= Date.parse(context.expiresAt))) {
    throw new Error('provider_session_channel_deadline');
  }
}

export function providerSessionDispatchDeadline(context: Readonly<ProviderSessionDispatchContext> | undefined, expiresAt: string) {
  return Object.freeze({...context, expiresAt: new Date(Math.min(Date.parse(context?.expiresAt ?? expiresAt), Date.parse(expiresAt))).toISOString()});
}
