import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as relayClient from '@dharma-ai-labs/agent-fabric-relay-client';

// Run the bootstrap's actual diagnostic observer; the top-level handler still prints the bare code after it.
async function stderrFor(diagnostic: Record<string, string>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let observer: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onFailureDiagnostic') observer = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(observer);
  const compiled = ts.transpileModule(`return ${observer};`, {compilerOptions: {target: ts.ScriptTarget.ES2023}}).outputText;
  const lines: string[] = [];
  const process = {stderr: {write: (line: string) => {lines.push(line);}}};
  const message = (relayClient as unknown as Record<string, unknown>).setupClaimFailureMessage;
  const dharmaHome = () => home;
  compileFunction(compiled, ['process', 'setupClaimFailureMessage', 'dharmaHome', 'claimPlatform'])(
    process, message, dharmaHome, platformName)(diagnostic);
  return lines;
}
let home = '/home/dev/.dharma';
let platformName = 'linux';
const report = {schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase: 'finalize'};
const correlationId = '55555555-5555-4555-8555-555555555555';

test('expired browser approval prints the plain reason, the next step and the correlation ID', async () => {
  const diagnostic = {...report, reason: 'approval_expired', correlationId};
  const lines = await stderrFor(diagnostic);
  assert.deepEqual(JSON.parse(lines[0]!), diagnostic);
  assert.equal(lines[1], `setup_claim_failed (approval_expired): Browser approval expired: setup did not receive an approval in time. Get a fresh setup prompt from Dharma and run it. Correlation ID: ${correlationId}.\n`);
  assert.equal(lines.length, 2);
});

test('expired browser approval without a correlation ID does not invent one', async () => {
  const lines = await stderrFor({...report, reason: 'approval_expired'});
  assert.equal(lines[1], 'setup_claim_failed (approval_expired): Browser approval expired: setup did not receive an approval in time. Get a fresh setup prompt from Dharma and run it.\n');
});

test('other finalize failures print their typed reason and server code', async () => {
  const lines = await stderrFor({...report, reason: 'server_rejected', serverCode: 'setup_claim_device_mismatch', correlationId});
  assert.equal(lines[1], `setup_claim_failed (server_rejected): Dharma rejected this setup (setup_claim_device_mismatch). Get a fresh setup prompt from Dharma and run it. If it fails again, send Dharma this line. Correlation ID: ${correlationId}.\n`);
  for (const [reason, text] of [['network_unavailable', /Could not reach Dharma/], ['response_invalid', /could not be verified/],
    ['canceled', /Setup was canceled/]] as const) {
    assert.match((await stderrFor({...report, reason}))[1]!, text);
  }
});

// G20 finding 1: a stale Dharma home stopped setup at identity with exit 2 and no remedy text.
test('a stale Dharma home prints the record, then the home path and the exact DHARMA_HOME remedy', async () => {
  const diagnostic = {...report, phase: 'identity', reason: 'stale_home'};
  home = 'C:\\Users\\dharma\\.dharma'; platformName = 'windows';
  try {
    const lines = await stderrFor(diagnostic);
    assert.deepEqual(JSON.parse(lines[0]!), diagnostic);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /^setup_claim_failed \(stale_home\): The Dharma home C:\\Users\\dharma\\\.dharma belongs to an earlier enrollment/);
    assert.match(lines[1]!, /No device key was written, nothing was deleted/);
    assert.match(lines[1]!, /Run: setx DHARMA_HOME "C:\\Users\\dharma\\\.dharma-2"\. Then fully restart the app or terminal/);
  } finally { home = '/home/dev/.dharma'; platformName = 'linux'; }
});

test('a phase without a typed reason keeps its existing single diagnostic line', async () => {
  const diagnostic = {...report, phase: 'store_preflight'};
  assert.deepEqual(await stderrFor(diagnostic), [`${JSON.stringify(diagnostic)}\n`]);
});
