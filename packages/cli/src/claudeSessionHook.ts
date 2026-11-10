import type { SessionMessagingHost } from './sessionNames.js';
export async function claudeHookCommand(_action: string, _input: { host: SessionMessagingHost; stdin: () => Promise<string> }):
  Promise<string> { throw new Error('not_implemented'); }
