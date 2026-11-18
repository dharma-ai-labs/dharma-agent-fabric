import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './index.js';
import { CLI_USAGE } from './usage.js';

test('delivery-only session commands skip the named-session Linux and workspace gates on every OS', async () => {
  // Options are refused by the delivery-only path itself, before any device, workspace or platform read.
  await assert.rejects(run(['sessions', 'attach', '--provider', 'codex', '--thread', 'not-a-thread', '--name', 'ef', '--yes']),
    /session_attach_options_invalid/);
  await assert.rejects(run(['sessions', 'attach', '--provider', 'claude', '--current', '--name', 'ops-claude']),
    /session_attach_consent_required|claude_current_session_unavailable/);
  await assert.rejects(run(['sessions', 'list', '--workspace-id', 'x']), /session_list_options_invalid/);
});

test('msg dispatches send, inbox, reply and ack and refuses anything else', async () => {
  await assert.rejects(run(['msg', 'send']), /session_message_options_invalid/);
  await assert.rejects(run(['msg', 'reply', '--body', 'x']), /session_message_options_invalid/);
  await assert.rejects(run(['msg', 'ack']), /session_message_options_invalid/);
  await assert.rejects(run(['msg', 'inbox', '--unknown']), /session_message_options_invalid/);
  await assert.rejects(run(['msg', 'forward']), /session_message_command_invalid/);
});

test('usage lists the session messaging commands', () => {
  for (const command of ['sessions attach', 'sessions list', 'msg send', 'msg inbox', 'msg reply', 'msg ack']) {
    assert.ok(CLI_USAGE.includes(command), command);
  }
});
