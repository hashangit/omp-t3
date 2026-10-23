'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HoldOpenTracker, holdOpenText, notifyFrame } = require('../src/notices.js');

function collectingEmitter(lines) {
  return (line) => lines.push(line);
}

test('notifyFrame carries the verified extension_ui_request notify shape', () => {
  const frame = JSON.parse(notifyFrame(1, 'Run held open: pending background work'));
  assert.equal(frame.type, 'extension_ui_request');
  assert.equal(frame.method, 'notify');
  assert.equal(frame.notifyType, 'info');
  assert.equal(frame.id, 'ompt3-notice-1');
  assert.ok(frame.message.length > 0, 'T3 rejects empty notify messages');
  // String content: single JSON line with trailing newline
  assert.match(notifyFrame(2, 'x'), /^\{.*\}\n$/);
});

test('holdOpenText states a subagent count only when it is authoritative', () => {
  assert.equal(holdOpenText({ pendingSubagents: 1, countAuthoritative: true }), 'Run held open: 1 pending subagent');
  assert.equal(holdOpenText({ pendingSubagents: 3, countAuthoritative: true }), 'Run held open: 3 pending subagents');
  assert.equal(holdOpenText({ pendingSubagents: 0, countAuthoritative: false }), 'Run held open: pending background work');
  assert.equal(holdOpenText({ pendingSubagents: 5, countAuthoritative: false }), 'Run held open: pending background work');
  assert.equal(holdOpenText({}), 'Run held open: pending background work');
  assert.equal(holdOpenText(undefined), 'Run held open: pending background work');
});

test('HoldOpenTracker emits once per hold interval and re-emits on signature change', () => {
  const lines = [];
  const tracker = new HoldOpenTracker(collectingEmitter(lines));

  // First signal: no known count -> generic background text
  assert.equal(tracker.tick({ pendingSubagents: 0, countAuthoritative: false }), true);
  assert.equal(JSON.parse(lines[0]).message, 'Run held open: pending background work');

  // Same signature: no duplicate
  assert.equal(tracker.tick({ pendingSubagents: 0, countAuthoritative: false }), false);
  assert.equal(lines.length, 1);

  // get_state probes with the same shape stay silent too
  assert.equal(tracker.tick({}), false);
  assert.equal(lines.length, 1);

  // A count became authoritative and grew: re-emit with the new text
  assert.equal(tracker.tick({ pendingSubagents: 2, countAuthoritative: true }), true);
  assert.equal(JSON.parse(lines[1]).message, 'Run held open: 2 pending subagents');

  // Same count: silent
  assert.equal(tracker.tick({ pendingSubagents: 2, countAuthoritative: true }), false);
  assert.equal(lines.length, 2);

  // One finished: signature change again
  assert.equal(tracker.tick({ pendingSubagents: 1, countAuthoritative: true }), true);
  assert.equal(JSON.parse(lines[2]).message, 'Run held open: 1 pending subagent');
});

test('HoldOpenTracker.clear() starts a fresh hold interval', () => {
  const lines = [];
  const tracker = new HoldOpenTracker(collectingEmitter(lines));
  tracker.tick({ pendingSubagents: 0, countAuthoritative: false });
  tracker.clear();
  // Same signature as before the clear, but a new hold: emits again
  assert.equal(tracker.tick({ pendingSubagents: 0, countAuthoritative: false }), true);
  assert.equal(lines.length, 2);
});

test('FR4 pin: a hold-open notice never carries settle semantics', () => {
  const lines = [];
  const tracker = new HoldOpenTracker(collectingEmitter(lines));
  tracker.tick({ pendingSubagents: 2, countAuthoritative: true });
  const frame = JSON.parse(lines[0]);
  assert.equal(frame.method, 'notify');
  // No settlement vocabulary in wire fields or text
  const raw = lines[0];
  assert.ok(!raw.includes('agent_settled'));
  assert.ok(!raw.includes('session_settled'));
  assert.ok(frame.message.startsWith('Run held open:'));
});
