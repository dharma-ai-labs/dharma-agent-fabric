import { types } from 'node:util';

export interface CooperativeSessionAnswer {
  questionId: string; taskId: string; nonce: string; offerHash: string; attemptId: string; answer: string;
}

export function snapshotCooperativeSessionAnswer(value: unknown): CooperativeSessionAnswer {
  // Reject proxies before reflection, then read descriptors rather than caller values.
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('cooperative_session_submission_invalid');
  }
  const fields = ['questionId', 'taskId', 'nonce', 'offerHash', 'attemptId', 'answer'] as const;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length) throw new Error('cooperative_session_submission_invalid');
  const snapshot = {} as CooperativeSessionAnswer;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!Object.hasOwn(descriptors, field) || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || typeof descriptor.value !== 'string') throw new Error('cooperative_session_submission_invalid');
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}
