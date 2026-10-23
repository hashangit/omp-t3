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

  // Pending background work (jobs/subagents) must hold T3's settle probe:
  // pendingMessageCount counts queued messages PLUS pending async work.
  const busy = tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"queuedMessageCount":0,"hasPendingAsyncWork":true}}');
  assert.equal(busy.handled, true);
  const busyParsed = JSON.parse(busy.emit);
  assert.equal(busyParsed.data.pendingMessageCount, 1);
  assert.equal(busyParsed.data.hasPendingAsyncWork, true);

  // Drained session reports 0 so the probe can finalize the run.
  const drained = tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"queuedMessageCount":0,"hasPendingAsyncWork":false}}');
  assert.equal(JSON.parse(drained.emit).data.pendingMessageCount, 0);
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

// --- Faithful session mirroring (background-pending turns) ---

test('mirror: agent_end with pending work does not settle; wake + session_settled does', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "run sleep 90 in background"}');
  const startRes = tracker.handleDownstreamFrame('{"type":"agent_start"}');
  assert.equal(startRes.handled, false); // passthrough untouched

  // Foreground cycle ends while the background job still runs: the T3 run
  // must stay open so the wake cycle can deliver the results into it.
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(endRes.handled, false); // byte passthrough, no synthesis

  // omp announces the pause; nothing may settle the run here.
  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, true);
  assert.equal(prRes.emit, undefined);

  // Drain: omp's wake cycle reports the results, then the session settles.
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const wakeEnd = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(wakeEnd.handled, false); // wake end is still not a settle point

  const ssRes = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(ssRes.handled, true);
  assert.equal(ssRes.suppress, false);
  const settled = JSON.parse(ssRes.emit.trim());
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);
});

test('mirror: clean foreground turn settles exactly once, from session_settled', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "hi"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(endRes.handled, false); // no cycle-boundary settle

  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":true}');
  assert.equal(prRes.suppress, true); // suppressed AND not a settle point (frames were seen)
  assert.equal(prRes.emit, undefined);

  const ssRes = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(JSON.parse(ssRes.emit.trim()).type, 'agent_settled');
});

test('mirror: abort during an active cycle synthesizes the terminal at agent_end', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "long work"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleUpstreamFrame('{"type": "abort"}');
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(endRes.handled, true);
  const lines = endRes.emit.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse('{"type":"agent_end","isTerminal":true}')); // forwarded untouched
  const settled = JSON.parse(lines[1]);
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, true);

  // The next turn clears the abort flag: a fresh cycle settles normally.
  tracker.handleUpstreamFrame('{"type": "prompt", "message": "retry"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const next = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(next.handled, false); // no settle - awaits session_settled
});

test('mirror: idle abort (paused run, no cycle) synthesizes the terminal immediately', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "start server"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');

  // Run is paused on the pending server; the user hits Stop. No cycle is
  // open, so no agent_end will arrive - the settle must come at once.
  const res = tracker.handleUpstreamFrame('{"type": "abort"}');
  assert.ok(res, 'idle abort must synthesize a settle');
  const settled = JSON.parse(res.emit.trim());
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, true);
});

test('mirror: abort during an active cycle waits for agent_end (no idle synthesis)', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "work"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const res = tracker.handleUpstreamFrame('{"type": "abort"}');
  assert.equal(res, null); // cycle open: agent_end owns the synthesis
});

test('mirror: prompt_result fallback settles only for mid-turn attach without pending work', () => {
  const tracker = new SettlementTracker();

  // Attached mid-turn, no agent frames seen, work drained: settle now.
  tracker.handleUpstreamFrame('{"type": "prompt", "message": "attached mid-turn"}');
  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":true}');
  assert.equal(prRes.handled, true);
  assert.equal(prRes.suppress, false);
  const settled = JSON.parse(prRes.emit.trim());
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);

  // Same shape but omp reports pending work: the run must stay open.
  const tracker2 = new SettlementTracker();
  tracker2.handleUpstreamFrame('{"type": "prompt", "message": "attached mid-turn, work pending"}');
  const prRes2 = tracker2.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(prRes2.handled, true);
  assert.equal(prRes2.suppress, true);
  assert.equal(prRes2.emit, undefined);

  // ...and the later session_settled finalizes it.
  const ssRes = tracker2.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(JSON.parse(ssRes.emit.trim()).type, 'agent_settled');
});

test('mirror: agent_end without a prior agent_start passes through untouched', () => {
  const tracker = new SettlementTracker();
  const res = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":true}');
  assert.equal(res.handled, false);
});

test('mirror: subagent_event payload embedding agent_end must not close the parent cycle', () => {
  const tracker = new SettlementTracker();

  tracker.handleUpstreamFrame('{"type": "prompt", "message": "spawn"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  const subEvent = '{"type":"subagent_event","payload":{"parentToolCallId":"call_1","event":{"type":"agent_end"}}}';
  const res = tracker.handleDownstreamFrame(subEvent);
  assert.equal(res.handled, false); // owned by the subagent bridge

  // The parent cycle is still open: the real agent_end passes through
  // without settling (session_settled remains the settle point).
  const endRes = tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  assert.equal(endRes.handled, false);
});

// --- Hold-open notices (feature 002 FR4) ---

test('hold-open: prompt_result with sessionSettled:false fires the hold observer, settle timing unchanged', () => {
  const tracker = new SettlementTracker();
  const holds = [];
  tracker.onHoldOpen = (info) => holds.push(info);

  tracker.handleUpstreamFrame('{"type":"prompt","message":"run sleep 90 &"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  const prRes = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(prRes.emit, undefined, 'hold observability must not alter settle suppression');
  assert.equal(holds.length, 1);
  assert.equal(holds[0].pendingSubagents, 0, 'no supplier wired: count 0');
  assert.equal(holds[0].countAuthoritative, false);

  // Prompt completes without withholding: no hold signal
  const tracker2 = new SettlementTracker();
  tracker2.handleUpstreamFrame('{"type":"prompt","message":"hi"}');
  tracker2.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":true}');
  assert.equal(tracker2.onHoldOpen, null);
});

test('hold-open: subagent count is authoritative only when the supplier reports live children', () => {
  const tracker = new SettlementTracker();
  const holds = [];
  tracker.onHoldOpen = (info) => holds.push(info);
  tracker.pendingSubagents = () => 2;

  tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(holds.length, 1);
  assert.deepEqual(holds[0], { pendingSubagents: 2, countAuthoritative: true });
});

test('hold-open: get_state probe with pending async work also refreshes the hold', () => {
  const tracker = new SettlementTracker();
  const holds = [];
  tracker.onHoldOpen = (info) => holds.push(info);

  tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"queuedMessageCount":0,"hasPendingAsyncWork":true}}');
  assert.equal(holds.length, 1);
  assert.equal(JSON.stringify(holds[0].pendingSubagents), '0');

  // Drained probe: no hold signal
  tracker.handleDownstreamFrame('{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false,"queuedMessageCount":0,"hasPendingAsyncWork":false}}');
  assert.equal(holds.length, 1);
});

test('hold-open: agentInvoked:false prompt_result never signals a hold', () => {
  const tracker = new SettlementTracker();
  const holds = [];
  tracker.onHoldOpen = (info) => holds.push(info);
  tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":false,"sessionSettled":false}');
  assert.equal(holds.length, 0);
});

// --- Feature 002 FR10 pin ---

test('FR10 pin: compaction after a settled run neither re-settles, re-opens, nor kills the run', () => {
  const tracker = new SettlementTracker();

  // A background-pending run that settled via session_settled
  tracker.handleUpstreamFrame('{"type":"prompt","message":"run in background"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  const settled = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(JSON.parse(settled.emit.trim()).type, 'agent_settled');

  // omp later auto-compacts in the background (real post-settle timing)
  const start = tracker.handleDownstreamFrame('{"type":"auto_compaction_start"}');
  assert.equal(start.handled, true);
  const end = tracker.handleDownstreamFrame('{"type":"auto_compaction_end","result":{"summary":"post-settle","tokensBefore":3000},"aborted":false,"willRetry":false}');
  assert.equal(end.handled, true);
  const types = end.emit.split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ['compaction_start', 'compaction_end'], 'pair still passes through');
  assert.ok(!end.emit.includes('"agent_settled"'), 'no synthesized settle from compaction');

  // The tracker is not re-opened or poisoned: the next turn still settles
  // exactly once, from session_settled.
  tracker.handleUpstreamFrame('{"type":"prompt","message":"next"}');
  tracker.handleDownstreamFrame('{"type":"agent_start"}');
  tracker.handleDownstreamFrame('{"type":"agent_end","isTerminal":false}');
  const pr = tracker.handleDownstreamFrame('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}');
  assert.equal(pr.emit, undefined);
  const second = tracker.handleDownstreamFrame('{"type":"session_settled"}');
  assert.equal(JSON.parse(second.emit.trim()).type, 'agent_settled');
});
