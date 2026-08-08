import { resolve } from 'node:path';
import process from 'node:process';
import { executeProviderTask } from '../packages/provider-adapters/dist/index.js';

const provider = process.argv[2];
const workspace = resolve(process.argv[3] || '.');
if (!['codex', 'claude', 'agy'].includes(provider)) {
  throw new Error('Usage: node scripts/proof-provider-task.mjs <codex|claude|agy> [workspace]');
}

const result = await executeProviderTask({
  provider,
  workspace,
  instructions: 'Read package.json only. Reply with the package name dharma-agent-fabric and do not modify any file.',
  timeoutSeconds: 180,
  allowedCommandArgv: [],
  allowWrites: false,
});

let semanticMarkerObserved = false;
let apiRetryEvents = 0;
let terminalSubtype = null;
for (const line of result.stdout.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'api_retry') apiRetryEvents += 1;
    if (event.type === 'result') {
      terminalSubtype = typeof event.subtype === 'string' ? event.subtype : null;
      semanticMarkerObserved ||= typeof event.result === 'string' && event.result.includes('dharma-agent-fabric');
    }
    if (event.type === 'assistant') semanticMarkerObserved ||= JSON.stringify(event.message || {}).includes('dharma-agent-fabric');
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      semanticMarkerObserved ||= typeof event.item.text === 'string' && event.item.text.includes('dharma-agent-fabric');
    }
    if (event.type === 'turn.completed') terminalSubtype = 'turn.completed';
  } catch {
    // Provider diagnostics are excluded from semantic proof.
  }
}
process.stdout.write(`${JSON.stringify({
  ok: result.exitCode === 0 && !result.timedOut && semanticMarkerObserved,
  provider,
  exitCode: result.exitCode,
  signal: result.signal,
  timedOut: result.timedOut,
  semanticMarkerObserved,
  apiRetryEvents,
  terminalSubtype,
  stdoutBytes: Buffer.byteLength(result.stdout),
  stderrBytes: Buffer.byteLength(result.stderr),
  stdoutSha256: result.stdoutSha256,
  stderrSha256: result.stderrSha256,
})}\n`);

if (result.exitCode !== 0 || result.timedOut || !semanticMarkerObserved) process.exitCode = 1;
