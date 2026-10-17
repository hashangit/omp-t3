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

test('SettlementTracker treats abort_and_prompt as aborted', () => {
  const tracker = new SettlementTracker();
  tracker.handleUpstreamFrame('{"type": "prompt", "message": "hello"}');
  tracker.handleUpstreamFrame('{"type": "abort_and_prompt", "message": "redo"}');
  assert.equal(tracker.lastPromptStatus, 'aborted');
});

test('SettlementTracker remaps auto_compaction frames to pi compaction names', () => {
  const tracker = new SettlementTracker();
  const start = tracker.handleDownstreamFrame('{"type":"auto_compaction_start"}');
  assert.equal(start.handled, true);
  assert.equal(start.suppress, true, 'start is buffered until the end frame arrives');

  const end = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","result":{"summary":"s","tokensBefore":100,"estimatedTokensAfter":50},"willRetry":false}');
  assert.equal(end.handled, true);
  const [startLine, endLine] = end.emit.split('\n').filter(Boolean);
  assert.equal(JSON.parse(startLine).type, 'compaction_start', 'buffered start flushes with the end');
  const endParsed = JSON.parse(endLine);
  assert.equal(endParsed.type, 'compaction_end');
  assert.equal(endParsed.result.tokensBefore, 100);
  assert.equal(endParsed.willRetry, false);
});

test('SettlementTracker injects pendingMessageCount alias into get_state responses', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"queuedMessageCount":2}}');
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.emit);
  assert.equal(parsed.data.pendingMessageCount, 2);
  assert.equal(parsed.data.queuedMessageCount, 2);
  // Non-matching get_state responses pass through untouched
  const res2 = tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":false,"error":"x"}');
  assert.equal(res2.handled, false);
});

test('manual compact: synthesizes compaction_start on upstream request', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleUpstreamFrame('{"id":"c1","type":"compact","customInstructions":"brief"}');
  assert.ok(res && res.emit, 'must emit synthesized start');
  const start = JSON.parse(res.emit);
  assert.equal(start.type, 'compaction_start');
  assert.equal(tracker.pendingManualCompact, true);
  // a later prompt must not disturb the pending compact flag
  tracker.handleUpstreamFrame('{"type":"prompt","message":"hi"}');
  assert.equal(tracker.pendingManualCompact, true, 'prompt must not clear a pending compact');
});

test('manual compact: success response becomes compaction_end + forwarded response', () => {
  const tracker = new SettlementTracker();
  tracker.handleUpstreamFrame('{"type":"compact"}');
  const line = '{"id":"7","type":"response","command":"compact","success":true,"data":{"summary":"Talked about TCP.","tokensBefore":8123}}';
  const res = tracker.handleDownstreamFrame(line);
  assert.equal(res.handled, true);
  const [endLine, fwdLine] = res.emit.split('\n');
  const end = JSON.parse(endLine);
  assert.equal(end.type, 'compaction_end');
  assert.equal(end.aborted, false);
  assert.equal(end.result.summary, 'Talked about TCP.');
  assert.equal(end.result.tokensBefore, 8123);
  assert.equal(JSON.parse(fwdLine).command, 'compact', 'original response must still forward');
  assert.equal(tracker.pendingManualCompact, false);
});

test('manual compact: failure response carries errorMessage', () => {
  const tracker = new SettlementTracker();
  tracker.handleUpstreamFrame('{"type":"compact"}');
  const res = tracker.handleDownstreamFrame('{"id":"8","type":"response","command":"compact","success":false,"error":"Nothing to compact (session too small)"}');
  assert.equal(res.handled, true);
  const [endLine, fwdLine] = res.emit.split('\n');
  const end = JSON.parse(endLine);
  assert.equal(end.type, 'compaction_end');
  assert.equal(end.errorMessage, 'Nothing to compact (session too small)');
  assert.equal(end.result, undefined);
  assert.equal(JSON.parse(fwdLine).success, false);
});

test('manual compact: response without pending request is untouched', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame('{"id":"9","type":"response","command":"compact","success":true}');
  assert.equal(res.handled, false);
});

test('auto compaction: skipped attempt pair is fully suppressed (real omp frames)', () => {
  const tracker = new SettlementTracker();
  const start = tracker.handleDownstreamFrame('{"type":"auto_compaction_start","reason":"overflow","action":"shake"}');
  assert.equal(start.handled, true);
  assert.equal(start.suppress, true, 'start must be buffered, not forwarded');
  const end = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","action":"shake","aborted":false,"willRetry":false,"skipped":true,"errorMessage":"Auto-shake found nothing eligible to drop; trying the next preferred compaction method."}');
  assert.equal(end.handled, true);
  assert.equal(end.suppress, true, 'skipped pair must never reach T3 (would render "Context compaction failed")');
  assert.equal(end.emit, undefined);
});

test('auto compaction: successful pair forwards start+translated end together', () => {
  const tracker = new SettlementTracker();
  tracker.handleDownstreamFrame('{"type":"auto_compaction_start","reason":"threshold","action":"context-full"}');
  const res = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","action":"context-full","result":{"summary":"Compacted.","tokensBefore":9000},"aborted":false,"willRetry":false}');
  assert.equal(res.handled, true);
  const lines = res.emit.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'compaction_start');
  const end = JSON.parse(lines[1]);
  assert.equal(end.type, 'compaction_end');
  assert.equal(end.result.summary, 'Compacted.');
});

test('auto compaction: aborted pair forwards (T3 renders stopped card)', () => {
  const tracker = new SettlementTracker();
  tracker.handleDownstreamFrame('{"type":"auto_compaction_start","reason":"overflow","action":"context-full"}');
  const res = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","action":"context-full","result":null,"aborted":true,"willRetry":false}');
  assert.equal(res.handled, true);
  assert.ok(res.emit.includes('compaction_start'));
  const end = JSON.parse(res.emit.split('\n').filter(Boolean)[1]);
  assert.equal(end.aborted, true);
});

test('auto compaction: end without buffered start still translates (real failed attempt)', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","action":"context-full","aborted":false,"willRetry":false,"errorMessage":"provider exploded"}');
  assert.equal(res.handled, true);
  const end = JSON.parse(res.emit);
  assert.equal(end.type, 'compaction_end');
  assert.equal(end.errorMessage, 'provider exploded');
});

test('SettlementTracker synthesizes agent_settled for local-only commands (agentInvoked:false)', () => {
  const tracker = new SettlementTracker();
  const response = '{"id":9,"type":"response","command":"prompt","success":true,"data":{"agentInvoked":false}}';
  const res = tracker.handleDownstreamFrame(response);
  assert.equal(res.handled, true);
  assert.equal(res.suppress, false); // original response still reaches T3
  const lines = res.emit.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse(response));
  const settled = JSON.parse(lines[1]);
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);
});

test('SettlementTracker leaves agent-invoked prompt responses untouched', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame(
    '{"id":10,"type":"response","command":"prompt","success":true,"data":{"agentInvoked":true}}'
  );
  assert.equal(res.handled, false);

  // Non-prompt responses mentioning the field must not trigger either
  const other = tracker.handleDownstreamFrame(
    '{"id":11,"type":"response","command":"get_state","success":true,"data":{"agentInvoked":false}}'
  );
  assert.equal(other.handled, false);
});

// --- Agent cycle settlement (background-pending turns) ---

test('cycle settle: agent_end settles the turn when omp withholds session_settled (background work pending)', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "run sleep 90"}');
  const startRes = tracker.handleDownstreamFrame('{"type":"agent_start"}');
  assert.equal(startRes.handled, false); // passthrough untouched

  const endLine = '{"type":"agent_end","isTerminal":false}';
  const endRes = tracker.handleDownstreamFrame(endLine);
  assert.equal(endRes.handled, true);
  assert.equal(endRes.suppress, false);
  const lines = endRes.emit.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse(endLine)); // agent_end forwarded untouched
  const settled = JSON.parse(lines[1]);
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);

  // prompt_result with sessionSettled:false must not synthesize a duplicate
  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, true);
  assert.equal(prRes.emit, undefined);
});

test('cycle settle: full normal cycle still emits translated session_settled after agent_end synthesis', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "hi"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(endRes.handled, true);
  assert.ok(endRes.emit.includes('"agent_settled"'));

  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":true}');
  assert.equal(prRes.suppress, true); // prompt_result never reaches T3

  // session_settled translation stays intact; T3 tolerates the duplicate
  const ssRes = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(ssRes.handled, true);
  assert.equal(ssRes.suppress, false);
  assert.equal(JSON.parse(ssRes.emit.trim()).type, 'agent_settled');
});

test('cycle settle: steered and wake cycles each settle once (state resets on agent_start)', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "work"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const first = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(first.emit.includes('"agent_settled"'), true);

  // Steer cycle: omp emits no prompt_result for it
  tracker.handleUpstreamFrame('{"type": "steer", "message": "done?"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const second = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(second.emit.includes('"agent_settled"'), true);

  // Wake cycle
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const third = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(third.emit.includes('"agent_settled"'), true);
});

test('cycle settle: upstream abort marks the synthesized settle aborted', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "long work"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleUpstreamFrame('{"type": "abort"}');
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(endRes.handled, true);
  const settled = JSON.parse(endRes.emit.trim().split('\n')[1]);
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, true);

  // The next cycle clears the abort flag
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleUpstreamFrame('{"type": "prompt", "message": "retry"}');
  const next = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  const nextSettled = JSON.parse(next.emit.trim().split('\n')[1]);
  assert.equal(nextSettled.aborted, false);
});

test('cycle settle: prompt_result fallback settles when no agent frames were observed', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "attached mid-turn"}');
  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, false);
  const settled = JSON.parse(prRes.emit.trim());
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);

  // session_settled translation still works afterwards
  const ssRes = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(JSON.parse(ssRes.emit.trim()).type, 'agent_settled');
});

test('cycle settle: agent_end without a prior agent_start passes through untouched', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(res.handled, false);
});

test('cycle settle: subagent_event payload embedding agent_end must not settle the parent cycle', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "spawn"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const subEvent = '{"type":"subagent_event","payload":{"parentToolCallId":"call_1","event":{"type":"agent_end"}}}';
  const res = tracker.handleDownstreamFrame(subEvent);
  assert.equal(res.handled, false); // owned by the subagent bridge

  // The parent cycle is still open and settles on the real agent_end
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(endRes.handled, true);
  assert.ok(endRes.emit.includes('"agent_settled"'));
});
