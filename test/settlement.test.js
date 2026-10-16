'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettlementTracker } = require('../src/settlement.js');

test('SettlementTracker translates session_settled to agent_settled (normal completion)', () => {
  const tracker = new SettlementTracker();

  // Turn starts
  tracker.handleUpstreamFrame('{"type": "prompt", "message": "hello"}');
  assert.equal(tracker.lastPromptStatus, null);

  // OMP outputs prompt_result (completed)
  const prRes = tracker.handleDownstreamFrame('{"type": "prompt_result", "status": "completed"}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, true);
  assert.equal(tracker.lastPromptStatus, 'completed');

  // OMP outputs session_settled
  const ssRes = tracker.handleDownstreamFrame('{"type": "session_settled"}');
  assert.equal(ssRes.handled, true);
  assert.equal(ssRes.suppress, false);
  const emitted = JSON.parse(ssRes.emit.trim());
  assert.equal(emitted.type, 'agent_settled');
  assert.equal(emitted.aborted, false);
});

test('SettlementTracker handles aborted turn when upstream abort frame sent', () => {
  const tracker = new SettlementTracker();

  // Upstream abort
  tracker.handleUpstreamFrame('{"type": "abort"}');
  assert.equal(tracker.lastPromptStatus, 'aborted');

  // OMP outputs prompt_result (aborted)
  const prRes = tracker.handleDownstreamFrame('{"type": "prompt_result", "status": "aborted"}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, true);

  // OMP outputs session_settled
  const ssRes = tracker.handleDownstreamFrame('{"type": "session_settled"}');
  assert.equal(ssRes.handled, true);
  const emitted = JSON.parse(ssRes.emit.trim());
  assert.equal(emitted.type, 'agent_settled');
  assert.equal(emitted.aborted, true);
});

test('SettlementTracker handles aborted turn when only prompt_result indicates aborted', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "test"}');
  tracker.handleDownstreamFrame('{"type": "prompt_result", "status": "aborted"}');

  const ssRes = tracker.handleDownstreamFrame('{"type": "session_settled"}');
  const emitted = JSON.parse(ssRes.emit.trim());
  assert.equal(emitted.type, 'agent_settled');
  assert.equal(emitted.aborted, true);
});

test('SettlementTracker passes through regular frames untouched', () => {
  const tracker = new SettlementTracker();

  const msgUpdate = '{"type": "message_update", "text_delta": "Hello world"}';
  const res = tracker.handleDownstreamFrame(msgUpdate);
  assert.equal(res.handled, false);
});

test('SettlementTracker suppresses advisor_cost_changed frames', () => {
  const tracker = new SettlementTracker();

  const res = tracker.handleDownstreamFrame('{"type": "advisor_cost_changed", "cost": 0.001}');
  assert.equal(res.handled, true);
  assert.equal(res.suppress, true);
});
