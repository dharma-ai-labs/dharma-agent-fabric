import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStudyExactPoll, studyTaskIdFromFlags } from './studyExactTaskSelector.js';

const TASK = '3b671bac-7ec8-4809-b8f3-1ddfb3e08b20';
const WORKSPACE = 'bdd7b919-c68a-5206-8e42-a5e069da8593';

test('ordinary run-once has no selector', () => {
  assert.equal(studyTaskIdFromFlags(new Map([['workspace-id', WORKSPACE]]), WORKSPACE), undefined);
});

test('study task selector requires explicit workspace and canonical task id', () => {
  assert.equal(studyTaskIdFromFlags(new Map([['study-task-id', TASK], ['workspace-id', WORKSPACE]]), WORKSPACE), TASK);
  assert.throws(() => studyTaskIdFromFlags(new Map([['study-task-id', TASK]]), WORKSPACE));
  assert.throws(() => studyTaskIdFromFlags(new Map<string, string | boolean>([['study-task-id', true], ['workspace-id', WORKSPACE]]), WORKSPACE));
  assert.throws(() => studyTaskIdFromFlags(new Map([['study-task-id', 'bad'], ['workspace-id', WORKSPACE]]), WORKSPACE));
});

test('exact poll requires server acknowledgement before trusting a task row', () => {
  const task = { envelope: { taskId: TASK, workspaceId: WORKSPACE } };
  assert.doesNotThrow(() => assertStudyExactPoll({ selectedStudyTaskId: TASK, task }, TASK, WORKSPACE));
  assert.doesNotThrow(() => assertStudyExactPoll({ selectedStudyTaskId: TASK, task: null }, TASK, WORKSPACE));
  assert.throws(() => assertStudyExactPoll({ task }, TASK, WORKSPACE));
  assert.throws(() => assertStudyExactPoll({ selectedStudyTaskId: TASK,
    task: { envelope: { taskId: 'other', workspaceId: WORKSPACE } } }, TASK, WORKSPACE));
  assert.throws(() => assertStudyExactPoll({ selectedStudyTaskId: TASK,
    task: { envelope: { taskId: TASK, workspaceId: 'other' } } }, TASK, WORKSPACE));
});
