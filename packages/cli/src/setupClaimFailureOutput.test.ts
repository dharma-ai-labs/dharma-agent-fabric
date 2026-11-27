import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as relayClient from '@dharma-ai-labs/agent-fabric-relay-client';

// Run the bootstrap's actual diagnostic observer; the top-level handler still prints the bare code after it.
async function stderrFor(diagnostic: Record<string, string | number>) {
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
  compileFunction(compiled, ['process', 'setupClaimFailureMessage'])(process, message)(diagnostic);
  return lines;
}
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

test('a phase without a typed reason keeps its existing single diagnostic line', async () => {
  const diagnostic = {...report, phase: 'store_preflight'};
  assert.deepEqual(await stderrFor(diagnostic), [`${JSON.stringify(diagnostic)}\n`]);
});

test('a clock too far off to correct names the measured offset and the next step', async () => {
  const diagnostic = {...report, phase: 'challenge', reason: 'clock_skew', clockOffsetSeconds: -172_800};
  const lines = await stderrFor(diagnostic);
  assert.deepEqual(JSON.parse(lines[0]!), diagnostic);
  assert.equal(lines[1], "setup_claim_failed (clock_skew): This computer's clock is about 2 days ahead of Dharma's time, more than setup corrects automatically (45 seconds). Turn on automatic date and time on this computer, then get a fresh setup prompt from Dharma and run it.\n");
  assert.match((await stderrFor({...diagnostic, clockOffsetSeconds: 5_400}))[1]!, /clock is about 90 minutes behind Dharma's time/);
  assert.match((await stderrFor({...diagnostic, clockOffsetSeconds: 241}))[1]!, /clock is about 241 seconds behind Dharma's time/);
});

test('a Linux host without an unlocked Secret Service prints the keyring fix after the diagnostic', async () => {
  const diagnostic = {...report, phase: 'store_preflight', reason: 'credential_store_unavailable'};
  const lines = await stderrFor(diagnostic);
  assert.deepEqual(JSON.parse(lines[0]!), diagnostic);
  assert.equal(lines[1], "setup_claim_failed (credential_store_unavailable): Setup could not use the Linux Secret Service, where it keeps this device's key. Install secret-tool (libsecret-tools on Debian/Ubuntu, libsecret on Fedora/Arch) and a Secret Service keyring such as gnome-keyring or KWallet, unlocked in your user session, which the relay service also uses. A desktop login provides one. On a host without one, run loginctl enable-linger $USER, then start and unlock the keyring on the user bus (DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus), and unlock it again after each reboot. Get a fresh setup prompt from Dharma and run it.\n");
  assert.equal(lines.length, 2);
});
