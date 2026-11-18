import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  listProviderSessionFiles,
  providerSessionId,
  readSessionTurns,
  sessionWorkspaceQualified,
  type SessionTurn,
} from './index.js';

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, 'repo');
  await mkdir(workspace);
  return { root, workspace: await realpath(workspace) };
}

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 18, 10, minute, second)).toISOString();

// One Claude turn: a typed prompt, an assistant tool call, its tool result, and a reply.
function claudeTurn(cwd: string, turn: number, outputBytes = 64) {
  return [
    { type: 'user', cwd, timestamp: at(turn, 0), message: { role: 'user', content: `task ${turn}` } },
    { type: 'assistant', cwd, timestamp: at(turn, 1), message: { role: 'assistant', content: [
      { type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { file_path: 'README.md' } },
    ] } },
    { type: 'user', cwd, timestamp: at(turn, 2), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `toolu_${turn}`, content: 'x'.repeat(outputBytes) },
    ] } },
    { type: 'user', cwd, timestamp: at(turn, 3), isMeta: true, message: { role: 'user', content: 'caveat' } },
    { type: 'assistant', cwd, timestamp: at(turn, 4), message: { role: 'assistant', content: [{ type: 'text', text: `done ${turn}` }] } },
  ];
}

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

async function collect(iterator: AsyncIterable<SessionTurn>) {
  const turns: SessionTurn[] = [];
  for await (const turn of iterator) turns.push(turn);
  return turns;
}

test('a Claude session larger than the 8 MiB discovery window is read in full as consecutive turns', async () => {
  const { root, workspace } = await fixtureWorkspace('dharma-turns-long-');
  const path = join(root, 'session.jsonl');
  const records = Array.from({ length: 40 }, (_, turn) => claudeTurn(workspace, turn, 240_000)).flat();
  await writeFile(path, jsonl(records));
  assert.ok((await stat(path)).size > 9 * 1024 * 1024);

  const turns = await collect(readSessionTurns({ provider: 'claude', path, workspace }));
  assert.equal(turns.length, 40);
  assert.deepEqual(turns.map((turn) => turn.records.length), Array(40).fill(5));
  assert.ok(turns.every((turn) => turn.coverage === 'observed'));
  assert.ok(turns.every((turn) => turn.records.every((record) => record.coverage === 'observed')));
  assert.deepEqual(turns[0]!.records.map((record) => record.kind), ['user_message', 'tool_call', 'tool_result', 'user_message', 'agent_message']);
  assert.equal(turns[0]!.startOffset, 0);
  for (let index = 1; index < turns.length; index += 1) {
    assert.equal(turns[index]!.startOffset, turns[index - 1]!.endOffset, 'turns are contiguous byte ranges');
  }
  assert.equal(turns.at(-1)!.endOffset, (await stat(path)).size);
  assert.equal(turns.at(-1)!.atEndOfFile, true);
  assert.ok(turns.slice(0, -1).every((turn) => turn.atEndOfFile === false));
});

test('reading resumes at a byte offset and never consumes a line that is still being written', async () => {
  const { root, workspace } = await fixtureWorkspace('dharma-turns-resume-');
  const path = join(root, 'session.jsonl');
  await writeFile(path, jsonl([...claudeTurn(workspace, 0), ...claudeTurn(workspace, 1)]));
  const complete = await collect(readSessionTurns({ provider: 'claude', path, workspace }));
  assert.equal(complete.length, 2);
  const partialLine = JSON.stringify(claudeTurn(workspace, 2)[0]).slice(0, 40);
  await appendFile(path, partialLine);

  const before = await collect(readSessionTurns({ provider: 'claude', path, workspace }));
  assert.equal(before.length, 2);
  assert.equal(before.at(-1)!.endOffset, complete.at(-1)!.endOffset);

  const resumed = await collect(readSessionTurns({ provider: 'claude', path, workspace, startOffset: complete[0]!.endOffset }));
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.startOffset, complete[0]!.endOffset);
  assert.deepEqual(resumed[0]!.records.map((record) => record.timestamp), complete[1]!.records.map((record) => record.timestamp));
});

test('records outside the workspace, oversized lines and malformed lines make only their own turn partial', async () => {
  const { root, workspace } = await fixtureWorkspace('dharma-turns-partial-');
  const outside = join(root, 'other');
  const path = join(root, 'session.jsonl');
  const second = claudeTurn(workspace, 1);
  second[2] = { ...second[2]!, cwd: outside };
  const third = claudeTurn(workspace, 2, 300_000);
  await writeFile(path, [
    jsonl(claudeTurn(workspace, 0)),
    jsonl(second),
    jsonl(third),
    `${jsonl(claudeTurn(workspace, 3))}{not json\n`,
    jsonl(claudeTurn(workspace, 4)),
  ].join(''));

  const turns = await collect(readSessionTurns({ provider: 'claude', path, workspace, maximumRecordBytes: 262_144 }));
  assert.deepEqual(turns.map((turn) => turn.coverage), ['observed', 'partial', 'partial', 'partial', 'observed']);
  assert.equal(turns[1]!.records.length, 4, 'the out-of-workspace record is excluded');
  assert.equal(turns[2]!.records.length, 4, 'the oversized record is excluded');
  assert.equal(turns[3]!.records.length, 5, 'the malformed line is excluded');
});

test('Codex sessions split at turn identifiers and carry their prefix into the first turn', async () => {
  const { root, workspace } = await fixtureWorkspace('dharma-turns-codex-');
  const path = join(root, 'rollout.jsonl');
  const turnA = '019fcaab-6c8e-7432-bfb7-fc63efa3d728';
  const turnB = '019fcaac-6c8e-7432-bfb7-fc63efa3d729';
  await writeFile(path, jsonl([
    { type: 'session_meta', payload: { cwd: workspace }, timestamp: at(0) },
    { type: 'turn_context', payload: { turn_id: turnA, cwd: workspace }, timestamp: at(0, 1) },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first' }, timestamp: at(0, 2) },
    { type: 'turn_context', payload: { turn_id: turnB, cwd: workspace }, timestamp: at(1) },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second' }, timestamp: at(1, 1) },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'reply' }, timestamp: at(1, 2) },
  ]));
  const turns = await collect(readSessionTurns({ provider: 'codex', path, workspace }));
  assert.deepEqual(turns.map((turn) => turn.records.length), [3, 3]);
  assert.ok(turns.every((turn) => turn.coverage === 'observed'));
});

test('session files are listed newest first and qualified by their first recorded working directory', async () => {
  const { root, workspace } = await fixtureWorkspace('dharma-turns-list-');
  const projects = join(root, 'projects', 'slug');
  await mkdir(projects, { recursive: true });
  const inside = join(projects, 'inside.jsonl');
  const outside = join(projects, 'outside.jsonl');
  await writeFile(inside, jsonl([{ type: 'summary', summary: 'x' }, ...claudeTurn(workspace, 0)]));
  await writeFile(outside, jsonl(claudeTurn(join(root, 'elsewhere'), 0)));
  const files = await listProviderSessionFiles('claude', [join(root, 'projects')]);
  assert.deepEqual(files.map((file) => file.path).sort(), [inside, outside].sort());
  assert.equal(await sessionWorkspaceQualified('claude', inside, workspace), true);
  assert.equal(await sessionWorkspaceQualified('claude', outside, workspace), false);
  assert.match(providerSessionId('claude', inside), /^claude-[a-f0-9]{24}$/);
  assert.equal(providerSessionId('claude', inside), providerSessionId('claude', inside));
});
