'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubagentBridge } = require('../src/subagent.js');

test('SubagentBridge normalizes tool_execution_start with tool task to subagent', () => {
  const bridge = new SubagentBridge();
  const rawLine = JSON.stringify({
    type: 'tool_execution_start',
    tool: 'task',
    args: { prompt: 'Investigate bug' }
  });

  const res = bridge.handleDownstreamFrame(rawLine);
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.line);
  assert.equal(parsed.tool, 'subagent');
  assert.equal(parsed.type, 'tool_execution_start');
});

test('SubagentBridge normalizes task:subagent:event to subagent_event', () => {
  const bridge = new SubagentBridge();
  const rawLine = JSON.stringify({
    type: 'task:subagent:event',
    taskId: 'task-1',
    event: 'thought',
    delta: 'Analyzing...'
  });

  const res = bridge.handleDownstreamFrame(rawLine);
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.line);
  assert.equal(parsed.type, 'subagent_event');
  assert.equal(parsed.taskId, 'task-1');
});

test('SubagentBridge ignores unrelated frames', () => {
  const bridge = new SubagentBridge();
  const rawLine = JSON.stringify({
    type: 'message_update',
    text_delta: 'Hello'
  });

  const res = bridge.handleDownstreamFrame(rawLine);
  assert.equal(res.handled, false);
});
