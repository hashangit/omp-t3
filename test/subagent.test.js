'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubagentBridge } = require('../src/subagent.js');

/** Parses the single synthesized status frame from a bridge result. */
function statusOf(res) {
  return JSON.parse(res.line).partialResult.content[0].text;
}

// --- Byte-identical passthrough (no rename, no details rewrite) ---

test('task tool frames pass through byte-identical (no subagent rename)', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'call_1',
    toolName: 'task',
    args: { prompt: 'Investigate bug' }
  });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.handled, true);
  assert.equal(res.line, raw + '\n', 'frame forwarded untouched');

  const rawEnd = JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'task',
    result: { content: [], details: { progress: [{ index: 0, id: 'A', status: 'completed' }] } }
  });
  const resEnd = bridge.handleDownstreamFrame(rawEnd);
  const lines = resEnd.line.trim().split('\n');
  assert.equal(lines[0], rawEnd, 'end frame forwarded untouched (details left as omp sent them)');
  assert.ok(lines.length <= 2, 'at most one appended status line');
});

test('task frames with details carry no synthesized results[] merge', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_2',
    toolName: 'task',
    result: { content: [], details: { results: [{ index: 0, id: 'A', status: 'completed', task: 'Do a thing' }] } }
  });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(JSON.parse(res.line.trim().split('\n')[0]).result.details.results.length, 1);
  assert.equal(JSON.parse(res.line.trim().split('\n')[0]).result.details.progress, undefined);

  // Idempotent: a second pass changes nothing (nothing is ever rewritten).
  const second = bridge.handleDownstreamFrame(res.line.trim().split('\n')[0]);
  assert.equal(second.handled, true);
  assert.equal(second.line.trim().split('\n')[0], res.line.trim().split('\n')[0]);
});

test('leaves string-valued mentions of task literals untouched', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({ content: ' debated "name":"task" naming ' });
  assert.equal(bridge.handleDownstreamFrame(raw).handled, false);
});

test('leaves non-task tool_execution frames untouched', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'bash', result: { details: { results: [] } } });
  assert.equal(bridge.handleDownstreamFrame(raw).handled, false);
});

test('passes through non-JSON lines without corruption', () => {
  const bridge = new SubagentBridge();
  const raw = 'log: someone said "tool":"task" out loud';
  assert.equal(bridge.handleDownstreamFrame(raw).handled, false);
});

test('ignores unrelated frames and other event types entirely', () => {
  const bridge = new SubagentBridge();
  assert.equal(bridge.handleDownstreamFrame(JSON.stringify({ type: 'message_update', text_delta: 'Hello' })).handled, false);
  assert.equal(bridge.handleDownstreamFrame(JSON.stringify({ type: 'session_settled' })).handled, false);
});

// --- Status-line synthesis from subagent_* frames ---

test('subagent frames synthesize a task-card status line update', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call_9', toolName: 'task', args: {} }));

  const lc = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_lifecycle',
    payload: { id: 'EchoHi', agent: 'task', parentToolCallId: 'call_9', status: 'started', index: 0 }
  }));
  assert.equal(lc.handled, true);
  const upd = JSON.parse(lc.line);
  assert.equal(upd.type, 'tool_execution_update');
  assert.equal(upd.toolCallId, 'call_9');
  assert.equal(upd.toolName, 'task', 'status rides the plain task card');
  assert.equal(upd.partialResult.content[0].type, 'text');
  assert.equal(statusOf(lc), '0/1 done · running: EchoHi', 'generic task name falls back to the child id');

  const pg = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_progress',
    payload: { index: 0, agent: 'task', parentToolCallId: 'call_9', task: 'Say hi', progress: { index: 0, id: 'EchoHi', agent: 'task', status: 'running', task: 'Say hi', recentOutput: 'working on it', resolvedModelIdentity: 'zai/glm-5.3-flash' } }
  }));
  const text = statusOf(pg);
  assert.ok(text.includes('EchoHi (glm-5.3-flash)'), 'short model identity in the line');
  assert.ok(text.includes('working on it'), 'running narration from recentOutput');

  const ev = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_event',
    payload: { id: 'EchoHi', parentToolCallId: 'call_9', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer text' }] } } }
  }));
  assert.ok(statusOf(ev).includes('final answer text'), 'assistant text displaces the output tail');

  const done = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_lifecycle',
    payload: { id: 'EchoHi', agent: 'task', parentToolCallId: 'call_9', status: 'completed', index: 0 }
  }));
  assert.equal(statusOf(done), '1/1 done');
});

test('status line orders children by step and suppresses unattachable frames', () => {
  const bridge = new SubagentBridge();
  const orphan = bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_lifecycle', payload: { id: 'X', status: 'started' } }));
  assert.equal(orphan.handled, true);
  assert.equal(orphan.line, undefined, 'no task call ever seen and no explicit parent: nothing rendered');

  bridge.handleDownstreamFrame(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', args: {} }));
  const b2 = bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_progress', payload: { index: 1, agent: 'task', parentToolCallId: 'c1', task: 'B', progress: { index: 1, id: 'b2', status: 'running', task: 'B' } } }));
  const a1 = bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_progress', payload: { index: 0, agent: 'task', parentToolCallId: 'c1', task: 'A', progress: { index: 0, id: 'a1', status: 'running', task: 'A' } } }));
  const text = statusOf(a1);
  assert.ok(text.indexOf('a1') < text.indexOf('b2'), 'children appear in fleet-index order');
  assert.ok(statusOf(b2).includes('b2'));
});

test('subagent frames during later tools re-parent to the task call', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_task1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_task1","id":"child1","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_bash1","toolName":"bash","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_wait1","toolName":"wait","args":{}}');
  // Completion frames arrive while wait is active; omp attributes them to wait
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_wait1","id":"child1","index":0,"status":"completed","agent":"CardProbe","task":"probe steps"}}');
  assert.equal(res.handled, true);
  assert.equal(JSON.parse(res.line).toolCallId, 'call_task1', 'must attach to the task call, not wait/bash');
  assert.equal(bridge.subagentsByCall.get('call_task1').get('child1').agent, 'CardProbe');
  // Parentless frames also land on the recorded owner
  const res2 = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"progress":{"id":"child1","index":0,"agent":"CardProbe","task":"probe steps","status":"running","recentOutput":"step 2..."}}}');
  assert.equal(JSON.parse(res2.line).toolCallId, 'call_task1');
});

test('subagent_lifecycle failed status maps to an error outcome', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"failed","agent":"redteam","description":"Adversarial review"}}');
  assert.ok(statusOf(res).includes('1 failed/aborted'), 'failed children surface in the summary');
  const rec = bridge.childRegistry.get('c1');
  assert.equal(rec.stopReason, 'error');
  const entry = bridge.subagentsByCall.get('call_1').get('c1');
  assert.equal(entry.agent, 'redteam');
});

test('child named after the tool is titled by its id in the status line', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"child9","index":0,"status":"running","agent":"task"}}');
  const res = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"child9","index":0,"status":"running","agent":"task"}}}');
  assert.ok(statusOf(res).includes('child9'), 'line names the child, never the tool');
});

test('state map is pruned when the task tool call ends', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"c1","index":0,"status":"running"}}');
  assert.ok(bridge.subagentsByCall.has('call_t'));
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"call_t","toolName":"task","result":{"content":[{"type":"text","text":"done"}]}}');
  assert.equal(bridge.subagentsByCall.has('call_t'), false, 'ended task call must not hold child state');
});

// --- Observation of children carried by task tool frames ---

test('tool-frame children are observed and registry-attributed without wire changes', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  const raw = JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'task',
    result: {
      content: [],
      details: {
        progress: [
          { index: 0, id: 'StaticSubagentAnalysis', agent: 'scout', status: 'completed', task: 'Analyze the subagent bridge' },
          { index: 1, id: 'LiveSubagentProbe', agent: 'task', status: 'running', task: 'Probe the shim' },
          { index: 2, id: 'Watcher', agent: 'reviewer', status: 'aborted', task: 'Watch run' },
          { index: 3, id: 'Broken', agent: 'task', status: 'failed', task: 'Fail run' }
        ]
      }
    }
  });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.line.trim().split('\n')[0], raw, 'outgoing frame untouched');

  const rec = (id) => bridge.childRegistry.get(id);
  assert.equal(rec('StaticSubagentAnalysis').ownerCallId, 'call_1');
  assert.equal(rec('StaticSubagentAnalysis').finished, true);
  assert.equal(rec('LiveSubagentProbe').live, true, 'running child stays live for the sweep');
  assert.equal(rec('Watcher').stopReason, 'aborted');
  assert.equal(rec('Broken').stopReason, 'error');
  assert.equal(bridge.pendingCount(), 0, 'owning call ended: count non-authoritative');
});

test('FR19: a child observed only through task tool results is registry-tracked and swept', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'solo', index: 0, status: 'running', task: 'T' }] } }
  }));
  assert.equal(bridge.pendingCount(), 1, 'tool-result child counts as pending under its open call');
  const rec = bridge.childRegistry.get('solo');
  assert.equal(rec.ownerCallId, 'call_t');
  assert.equal(rec.live, true);

  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['solo'], 'cancelled by id');
  const end = JSON.parse(sweep.toClient[0]);
  assert.equal(end.type, 'tool_execution_end', 'open card closed');
  assert.equal(end.toolCallId, 'call_t');
  assert.ok(end.result.content[0].text.includes('interrupted'));
  assert.equal(bridge.pendingCount(), 0);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR15/FR17: a stale running tool update never un-finishes a completed child', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"completed"}}');

  const raw = JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'running', task: 'T' }] } }
  });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.line.trim().split('\n')[0], raw, 'stale observation forwards untouched');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').finished, true, 'tracked entry stays terminal');
  assert.equal(bridge.childRegistry.get('kid').live, false, 'registry liveness not resurrected');
  // Interrupt still closes the OPEN card (its child already completed):
  // one synthetic END carrying the terminal summary, no cancels.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  const end = JSON.parse(sweep.toClient[0]);
  assert.equal(end.type, 'tool_execution_end');
  assert.ok(end.result.content[0].text.includes('1/1 done'));
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: a completed tool record after a failed child preserves the error outcome', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"failed","agent":"redteam"}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  }));
  assert.equal(bridge.childRegistry.get('kid').stopReason, 'error', 'failed outcome not erased by a later completed record');
  // No cancels (child finished); the open card still closes.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  assert.equal(JSON.parse(sweep.toClient[0]).toolCallId, 'call_t');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: a completed tool record after an aborted child preserves interrupted', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"aborted","agent":"scout"}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  }));
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').stopReason, 'aborted');
});

test('FR17: an aborted tool record after a completed child does not relabel it', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  }));
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'aborted', task: 'T' }] } }
  }));
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').stopReason, undefined, 'canonical completed flavor kept');
});

test('narration: task-result lastIntent is recorded for the status line', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_i","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_i',
    toolName: 'task',
    result: {
      content: [],
      details: {
        results: [
          { index: 0, id: 'A', agent: 'scout', status: 'completed', task: 'T1' },
          { index: 1, id: 'B', agent: 'scout', status: 'running', task: 'T2', lastIntent: 'scanning deps' }
        ]
      }
    }
  }));
  assert.equal(bridge.subagentsByCall.get('call_i').get('B')._intent, 'scanning deps');
});

// --- Feature 002 FR4: pending count for hold-open notices ---

test('pendingCount counts unfinished children across open task calls', () => {
  const bridge = new SubagentBridge();
  assert.equal(bridge.pendingCount(), 0);
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c2","index":1,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_2","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_2","progress":{"id":"c3","index":0,"status":"running"}}}');
  assert.equal(bridge.pendingCount(), 3);

  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"completed"}}');
  assert.equal(bridge.pendingCount(), 2, 'finished children leave the count');
});

test('pendingCount returns 0 once the owning task call ends (count becomes non-authoritative)', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"running"}}');
  assert.equal(bridge.pendingCount(), 1);
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"call_1","toolName":"task","result":{"content":[]}}');
  assert.equal(bridge.pendingCount(), 0, 'detached children are not counted: callers fall back to generic hold text');
});

// --- Interrupt sweep ---


test('abortSweep closes an open task card that never reported children (P1 pin)', () => {
  const bridge = new SubagentBridge();
  // The task-start → first-child window: the call is open, no child yet.
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"solo_call","toolName":"task","args":{}}');
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, [], 'no observed children, no cancels');
  assert.equal(sweep.toClient.length, 1, 'the open card still closes');
  const end = JSON.parse(sweep.toClient[0]);
  assert.equal(end.type, 'tool_execution_end');
  assert.equal(end.toolCallId, 'solo_call');
  assert.ok(end.result.content[0].text.includes('interrupted'));
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('a lost get_subagents response does not pin reconciliation forever (stale-expiry pin)', () => {
  const bridge = new SubagentBridge();
  const first = bridge.refreshRequest();
  assert.ok(first, 'first request issued');
  assert.equal(bridge.refreshRequest(), null, 'single-flight while pending');
  // The response never arrives; after the stale window (which also
  // outlasts the rate limit) a new request goes out.
  bridge.refreshRequestedAt -= bridge.refreshStaleMs + 1;
  bridge.lastRefreshAt -= bridge.refreshMinIntervalMs + 1;
  const second = bridge.refreshRequest();
  assert.ok(second, 'stale pending flag is recoverable');
  assert.notEqual(JSON.parse(second).id, JSON.parse(first).id);
});
test('abortSweep closes open task cards and cancels live children on both sides', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"running","agent":"scout"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c2","index":1,"status":"completed","agent":"reviewer"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_2","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_2","progress":{"id":"c3","index":0,"status":"running"}}}');

  const sweep = bridge.abortSweep();

  // T3 side: one synthetic tool_execution_end per OPEN call with children.
  assert.equal(sweep.toClient.length, 2);
  const ends = sweep.toClient.map((l) => JSON.parse(l));
  assert.deepEqual(ends.map((e) => e.toolCallId), ['call_1', 'call_2']);
  for (const e of ends) {
    assert.equal(e.type, 'tool_execution_end');
    assert.equal(e.toolName, 'task');
    assert.ok(e.result.content[0].text.includes('interrupted'));
  }
  assert.ok(ends[0].result.content[0].text.includes('1 failed/aborted'), 'interrupted children counted as failures');
  assert.equal(bridge.childRegistry.get('c2').stopReason, undefined, 'already-completed child is not relabeled');

  // omp side: hard-kill only the still-live children.
  const cancels = sweep.toOmp.map((l) => JSON.parse(l));
  assert.deepEqual(cancels.map((c) => c.subagentId).sort(), ['c1', 'c3']);
  for (const c of cancels) {
    assert.equal(c.type, 'cancel_subagent');
    assert.ok(c.id.startsWith('ompt3-sub-'), 'bridge-injected ids live in the ompt3-sub- namespace');
  }

  assert.equal(bridge.pendingCount(), 0, 'nothing stays pending after the sweep');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR16: children re-attached after their task call ended cancel without card surgery', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"c1","index":0,"status":"running","agent":"scout"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  // Detached child keeps reporting after the parent's call ended (the
  // live-verified detached-children shape): its entry is re-attached.
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"callA","progress":{"id":"c1","index":0,"status":"running"}}}');
  assert.equal(bridge.pendingCount(), 0, 'ended call: count non-authoritative (unchanged pin)');

  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toClient, [], 'ended call: card already closed, no zombie is possible');
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['c1'], 'the live child still dies');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

// --- Reconciliation against omp's authoritative snapshot ---

test('get_subagents snapshot heals a missed spawn and is suppressed from T3', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_9","toolName":"task","args":{}}');

  const req = bridge.refreshRequest();
  assert.ok(req, 'first refresh request is issued');
  const reqFrame = JSON.parse(req);
  assert.equal(reqFrame.type, 'get_subagents');
  assert.ok(reqFrame.id.startsWith('ompt3-sub-'));
  assert.equal(bridge.refreshRequest(), null, 'single-flight while a refresh is pending');
  assert.equal(bridge.refreshRequest(), null, '...and rate-limited right after');

  const res = bridge.handleBridgeResponse(JSON.parse(JSON.stringify({
    type: 'response',
    id: reqFrame.id,
    command: 'get_subagents',
    success: true,
    data: {
      subagents: [
        {
          id: 'ghost',
          index: 0,
          agent: 'security-reviewer',
          status: 'running',
          task: 'Audit the bridge',
          parentToolCallId: 'call_9',
          progress: { resolvedModelIdentity: 'zai/glm-5.3', lastIntent: 'Reading src/proxy.js' }
        }
      ]
    }
  })));
  assert.equal(res.handled, true, 'bridge-injected responses never reach T3');
  const update = JSON.parse(res.emit.trim());
  assert.equal(update.type, 'tool_execution_update');
  assert.equal(update.toolCallId, 'call_9');
  const text = update.partialResult.content[0].text;
  assert.ok(text.includes('security-reviewer'));
  assert.ok(text.includes('glm-5.3'));
  assert.ok(text.includes('Reading src/proxy.js'), 'snapshot narration lands in the line');

  // Identical snapshot: no re-emission.
  const again = bridge.handleBridgeResponse(JSON.parse(JSON.stringify({
    type: 'response',
    id: 'ompt3-sub-2',
    command: 'get_subagents',
    success: true,
    data: { subagents: [{ id: 'ghost', index: 0, agent: 'security-reviewer', status: 'running', task: 'Audit the bridge', parentToolCallId: 'call_9', progress: { resolvedModelIdentity: 'zai/glm-5.3', lastIntent: 'Reading src/proxy.js' } }] }
  })));
  assert.equal(again.handled, true);
  assert.equal(again.emit, undefined, 'unchanged snapshots do not churn the wire');
});

test('snapshot never un-finishes an entry terminalized by an event', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"aborted","agent":"scout"}}');
  const res = bridge.handleBridgeResponse(JSON.parse(JSON.stringify({
    type: 'response',
    id: 'ompt3-sub-1',
    command: 'get_subagents',
    success: true,
    data: { subagents: [{ id: 'c1', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'call_1' }] }
  })));
  assert.equal(res.emit, undefined, 'no update when only weaker evidence exists');
  const sweep = bridge.abortSweep();
  assert.equal(sweep.toOmp.length, 0, 'terminalized children are not re-cancelled');
});

test('cancel_subagent responses are consumed and suppressed', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleBridgeResponse(JSON.parse(JSON.stringify({
    type: 'response',
    id: 'ompt3-sub-7',
    command: 'cancel_subagent',
    success: true,
    data: { cancelled: true }
  })));
  assert.equal(res.handled, true);
  assert.equal(res.emit, undefined);

  const foreign = bridge.handleBridgeResponse(JSON.parse(JSON.stringify({
    type: 'response',
    id: 'req-42',
    command: 'cancel_subagent',
    success: true
  })));
  assert.equal(foreign.handled, false, 'T3-originated responses are none of our business');
});

// --- Feature 002 US9/FR14/FR15/FR19: attribution under parallel fan-out ---

test('FR14: six concurrent task calls - explicit parents land true, parentless unknowns render nothing', () => {
  const bridge = new SubagentBridge();
  for (let i = 1; i <= 6; i++) {
    bridge.handleDownstreamFrame(`{"type":"tool_execution_start","toolCallId":"c${i}","toolName":"task","args":{}}`);
  }

  // Explicit parent references are trusted: the child lands on its true call.
  const explicit = JSON.parse(bridge.handleDownstreamFrame(
    '{"type":"subagent_progress","payload":{"parentToolCallId":"c3","progress":{"id":"x3","index":0,"status":"running","task":"true child of c3"}}}'
  ).line);
  assert.equal(explicit.toolCallId, 'c3');
  assert.ok(explicit.partialResult.content[0].text.includes('x3'));

  // The incident shape: parentless unknown children while six calls are
  // open. An open call alone is not ownership - nothing is rendered.
  const withheld = bridge.handleDownstreamFrame(
    '{"type":"subagent_progress","payload":{"progress":{"id":"ghost","index":4,"status":"running"}}}'
  );
  assert.equal(withheld.handled, true);
  assert.equal(withheld.line, undefined, 'ambiguous update renders nothing');
  assert.equal(withheld.refreshRequested, true, 'reconciliation is requested');

  // The withheld child is registered live and unattributed; no call owns it.
  const ghost = bridge.childRegistry.get('ghost');
  assert.equal(ghost.ownerCallId, null);
  assert.equal(ghost.live, true);
  assert.equal(ghost.status, 'running');
  for (const calls of bridge.subagentsByCall.values()) {
    assert.equal(calls.has('ghost'), false, 'no phantom entry under any parent');
  }
});

test('FR14/FR19: late orphan (parent call ended, later call open) is withheld, registered, cancelled', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');

  // A's unknown child reports parentless while B is open: the open call
  // alone must not adopt it.
  const res = bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"id":"orphan1","index":0,"status":"running","agent":"scout"}}'
  );
  assert.equal(res.line, undefined, 'nothing rendered under callB or anywhere');
  assert.equal(bridge.subagentsByCall.size, 0);
  assert.equal(bridge.childRegistry.get('orphan1').ownerCallId, null);
  assert.equal(bridge.childRegistry.get('orphan1').live, true, 'the hidden child stays tracked');

  // FR19: the sweep cancels the withheld child by id even though it was
  // never rendered; the only card output is the childless open callB
  // closing (the orphan itself renders nothing).
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toClient.map((l) => JSON.parse(l).toolCallId), ['callB'], 'withheld children contribute cancellations only');
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['orphan1']);

  // quickstart §10 item 6: reconciliation re-attributes it when a snapshot
  // carries its parent (callA stays known even though it ended): the child
  // re-attributes to its true owner in the registry; callA's card is
  // closed, so nothing renders for it (§5.0 — ended calls get registry and
  // cancellation semantics only).
  const healed = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-99', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'orphan1', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  assert.equal(healed.emit, undefined, 'no rendering for an ended call');
  assert.equal(bridge.childRegistry.get('orphan1').ownerCallId, 'callA', 'healed to its true parent');
});

test('FR14: parentless follow-up from an attributed child follows its recorded owner', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');

  const res = bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"id":"kid","index":0,"status":"completed"}}'
  );
  assert.equal(res.line, undefined, 'owner call ended: registry-only semantics, no rendering');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA', 'registry owner wins over the merely-open call');
  assert.equal(bridge.childRegistry.get('kid').finished, true);
});

test('FR15: duplicate fleet indices and missing indices get distinct stable steps', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"a","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"b","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_1","progress":{"id":"c","status":"running"}}}');
  const steps = new Set();
  for (const e of bridge.subagentsByCall.get('call_1').values()) steps.add(e.step);
  assert.equal(steps.size, 3, 'one distinct display step per child');
});

test('FR15: snapshot index disagreement never renumbers an attached child', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"kid","index":0,"status":"running"}}');

  const again = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 5, agent: 'scout', status: 'running', parentToolCallId: 'call_1' }] }
  });
  assert.ok(again.emit, 'snapshot enrichment still updates the line');
  const refreshed = JSON.parse(again.emit.trim());
  assert.equal(refreshed.toolCallId, 'call_1', 'same parent');
  assert.equal(bridge.subagentsByCall.get('call_1').size, 1, 'no second child minted');
  assert.equal(bridge.subagentsByCall.get('call_1').get('kid').step, 0, 'step frozen at first attach');
});

test('FR14: mid-turn attach - explicit parent anchors in the registry when no task call was ever seen', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_mid","id":"m1","index":0,"status":"running","agent":"scout"}}'
  );
  assert.equal(res.line, undefined, 'registry-only adoption renders nothing (P2-1/P2-2 fix)');
  assert.equal(bridge.childRegistry.get('m1').ownerCallId, 'call_mid', 'the explicit parent anchors');
  assert.equal(bridge.childRegistry.get('m1').live, true, 'the child stays tracked');
});

test('FR15: tool-result child at index 5 keeps its step when an event later claims index 0', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 5, status: 'running', task: 'T' }] } }
  }));
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'call_t');
  assert.equal(bridge.childRegistry.get('kid').step, 5);

  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"kid","index":0,"status":"running"}}}');
  assert.equal(bridge.subagentsByCall.get('call_t').size, 1, 'no duplicate child');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').step, 5, 'step frozen at first attach');
});

test('FR15: event-attached child keeps its step when a tool result claims another index', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 5, status: 'running' }] } }
  }));
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').step, 0);
  assert.equal(bridge.subagentsByCall.get('call_t').size, 1);
});

test('FR17: a snapshot re-attaching a finished child restores its terminal state', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"completed"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  assert.equal(bridge.subagentsByCall.has('callA'), false, 'map pruned at call end');

  const res = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  assert.equal(res.emit, undefined, 'ended call: no rendering');
  const kid = bridge.childRegistry.get('kid');
  assert.equal(kid.finished, true, 'terminal state restored in the registry, not resurrected as running');
  assert.equal(kid.live, false, 'registry liveness preserved');
  const sweep = bridge.abortSweep();
  assert.equal(sweep.toOmp.length, 0, 'finished children are not re-cancelled');
});

test('FR17: a snapshot after the sweep restores the swept terminal state', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running"}}');
  assert.equal(bridge.abortSweep().toOmp.length, 1);

  bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-9', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  assert.equal(bridge.childRegistry.get('kid').stopReason, 'aborted', 'swept outcome survives the snapshot');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR19: terminal stickiness holds for unattributed children (parentless completion then stale progress)', () => {
  const bridge = new SubagentBridge();
  // Parentless completion while six calls are open: withheld, registered finished.
  const w1 = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"progress":{"id":"ghost","index":0,"status":"completed"}}}');
  assert.equal(w1.line, undefined);
  assert.equal(bridge.childRegistry.get('ghost').finished, true);
  assert.equal(bridge.childRegistry.get('ghost').live, false);

  // Stale running progress for the same hidden child: no resurrection.
  const w2 = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"progress":{"id":"ghost","index":0,"status":"running"}}}');
  assert.equal(w2.line, undefined);
  assert.equal(bridge.childRegistry.get('ghost').finished, true, 'terminal outcome sticky');
  assert.equal(bridge.childRegistry.get('ghost').live, false, 'liveness stays dead');

  // The interrupt does not cancel the completed hidden child.
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR15: a conflicting explicit parent withholds and reconciles instead of duplicating', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');

  // First attribution wins: the child lands under A.
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA');

  // The same child reported under known task B: conflicting parent —
  // withheld from rendering, reconciliation requested, ownership intact.
  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"running","agent":"scout"}}');
  assert.equal(conflict.line, undefined, 'nothing rendered under B');
  assert.equal(conflict.refreshRequested, true, 'reconciliation requested');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA', 'ownership not renegotiated');
  assert.equal(bridge.subagentsByCall.has('callB'), false, 'no map, no duplicate child');
  assert.equal(bridge.subagentsByCall.get('callA').size, 1);

  // A snapshot echoing the conflicting parent also withholds — but keeps
  // the child live and tracked under its recorded owner.
  const snap = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callB' }] }
  });
  assert.equal(snap.emit, undefined, 'conflicting snapshot renders nothing');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA');
  assert.equal(bridge.childRegistry.get('kid').live, true);

  // The interrupt closes both open cards: A (owner) and B (no children —
  // the P1 sweep fix), and cancels the child exactly once.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['kid']);
  assert.deepEqual(sweep.toClient.map((l) => JSON.parse(l).type + ':' + JSON.parse(l).toolCallId).sort(), ['tool_execution_end:callA', 'tool_execution_end:callB']);
  const endA = JSON.parse(sweep.toClient.find((l) => JSON.parse(l).toolCallId === 'callA'));
  assert.ok(endA.result.content[0].text.includes('1/1 done'));
});

test('FR15: a conflicting tool-result child is adopted nowhere and reconciled', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  // B's task frame claims the child: forwarded untouched (the wire is never
  // rewritten), not tracked under B, reconciliation requested.
  const raw = JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'callB', toolName: 'task',
    partialResult: { content: [], details: { results: [{ id: 'kid', index: 0, status: 'running', task: 'T' }] } }
  });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.line, raw + '\n', 'conflicting observation forwarded untouched (generic cards do not render omp details)');
  assert.equal(res.refreshRequested, true, 'reconciliation requested');
  assert.equal(bridge.subagentsByCall.has('callB'), false, 'no tracked adoption under B');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA');

  // The child stays cancellable under its real owner.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['kid']);
});

test('FR17: a conflicting-parent completion terminalizes the recorded owner (event path)', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  // The same child completes, reported under conflicting parent B: nothing
  // renders under B, but the owner's line terminalizes.
  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"completed"}}');
  assert.equal(conflict.refreshRequested, true);
  assert.ok(conflict.line, 'owner status update emitted');
  const owner = JSON.parse(conflict.line);
  assert.equal(owner.toolCallId, 'callA', 'the update goes to the recorded owner');
  assert.equal(owner.partialResult.content[0].text, '1/1 done', 'completed flavor preserved');
  assert.equal(bridge.childRegistry.get('kid').stopReason, undefined);

  // Sticky: a later conflicting running frame changes nothing.
  const stale = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"callB","progress":{"id":"kid","index":0,"status":"running"}}}');
  assert.equal(stale.line, undefined);
  assert.equal(bridge.subagentsByCall.get('callA').get('kid').finished, true);

  // Registry terminal, live dead: the interrupt neither cancels nor relabels.
  // Registry terminal, live dead: no cancel, no relabel — but A's card is
  // still open, so the sweep closes it once.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  const end = JSON.parse(sweep.toClient[0]);
  assert.equal(end.toolCallId, 'callA');
  assert.ok(end.result.content[0].text.includes('1/1 done'));
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: a conflicting-parent completion in a snapshot terminalizes the owner', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const res = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'completed', parentToolCallId: 'callB' }] }
  });
  assert.ok(res.emit, 'owner update emitted from the snapshot path');
  assert.equal(JSON.parse(res.emit.trim()).toolCallId, 'callA');
  // No cancel; A's open card closes once with the terminal summary.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  const end = JSON.parse(sweep.toClient[0]);
  assert.equal(end.toolCallId, 'callA');
  assert.ok(end.result.content[0].text.includes('1/1 done'));
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: a conflicting tool-channel completion terminalizes the owner', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const raw = JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'callB', toolName: 'task',
    partialResult: { content: [], details: { results: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  });
  const res = bridge.handleDownstreamFrame(raw);
  const frames = res.line.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(frames[0].toolCallId, 'callB');
  assert.equal(res.line.trim().split('\n')[0], raw, 'conflicting frame forwarded untouched');
  const owner = frames.find((f) => f.toolCallId === 'callA');
  assert.ok(owner, 'owner status update appended to the outgoing line');
  assert.equal(owner.partialResult.content[0].text, '1/1 done');
  assert.equal(res.refreshRequested, true);

  // No cancel: the child was already completed; A's open card closes once.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  assert.equal(JSON.parse(sweep.toClient[0]).toolCallId, 'callA');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: conflicting failed status carries the error outcome to the owner', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"failed"}}');
  assert.equal(JSON.parse(conflict.line).toolCallId, 'callA');
  assert.ok(JSON.parse(conflict.line).partialResult.content[0].text.includes('1 failed/aborted'));
  assert.equal(bridge.childRegistry.get('kid').stopReason, 'error');
});

// --- P2-1 repair: unseen explicit parents are adopted, not hijacked ---

test('P2-1: two unseen mid-turn calls each keep their own children (registry-only adoption)', () => {
  const bridge = new SubagentBridge();
  // No task start was ever seen (shim attached mid-turn): two children
  // arrive, each with a DIFFERENT unseen explicit parent.
  const x1 = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callX","id":"X1","index":0,"status":"running","agent":"scout"}}');
  assert.equal(x1.line, undefined, 'adopted calls render nothing (no foreign-card synthesis)');
  const y1 = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callY","id":"Y1","index":0,"status":"running","agent":"auditor"}}');
  assert.equal(y1.line, undefined, 'second unseen call must NOT hijack into the first');
  assert.equal(bridge.childRegistry.get('X1').ownerCallId, 'callX');
  assert.equal(bridge.childRegistry.get('Y1').ownerCallId, 'callY', 'second unseen call anchors to its own parent');
  assert.equal(bridge.subagentsByCall.get('callY').get('Y1').agent, 'auditor');

  // The interrupt cancels both children by id; no synthetic card surgery
  // lands on calls T3 may not even hold (P2-1/P2-2 fix).
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId).sort(), ['X1', 'Y1']);
  assert.deepEqual(sweep.toClient, [], 'adopted calls have no bridge-rendered cards to close');
});

test('P2-1: a late parentless follow-up from a second-call child follows its true parent', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callX","id":"X1","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callY","id":"Y1","index":0,"status":"running"}}');
  // Parentless completion of the SECOND call's child: registry owner wins.
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"id":"Y1","index":0,"status":"completed"}}');
  assert.equal(res.line, undefined, 'adopted calls render nothing');
  assert.equal(bridge.childRegistry.get('Y1').ownerCallId, 'callY', 'registry owner wins over call history');
  assert.equal(bridge.childRegistry.get('Y1').finished, true);
});

test('distrusted parent: an explicit parent seen as a non-task tool is never adopted', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"c1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"w1","toolName":"wait","args":{}}');
  // Late event misattributed by omp to the wait call: must land on c1.
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"w1","id":"kid","index":0,"status":"running","agent":"scout"}}');
  assert.equal(JSON.parse(res.line).toolCallId, 'c1', 'non-task parents are distrusted; sole task call wins');
});

// --- Post-abort cancellation window (notification-bar stop hardening) ---

test('abort window: children surfacing after the sweep are cancelled on observation', () => {
  const bridge = new SubagentBridge();
  const cancels = [];
  bridge.onOmpLine = (l) => cancels.push(JSON.parse(l));
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  // Sweep on the childless open call: window armed, nothing to cancel yet.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, []);
  const end = JSON.parse(sweep.toClient[0]);
  assert.ok(end.result.content[0].text.includes('0/0 done'));

  // In-flight spawn finishes AFTER the sweep: observed live → insta-cancel.
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"late","index":0,"status":"running","agent":"straggler"}}');
  assert.deepEqual(cancels.map((c) => c.subagentId), ['late'], 'window cancels the straggler');
  assert.equal(bridge.childRegistry.get('late').stopReason, 'aborted');
  assert.equal(bridge.childRegistry.get('late').live, false);
});

test('abort window: a new prompt disarms it (next turn spawns freely)', () => {
  const bridge = new SubagentBridge();
  const cancels = [];
  bridge.onOmpLine = (l) => cancels.push(JSON.parse(l));
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"c1","toolName":"task","args":{}}');
  bridge.abortSweep();
  // The proxy calls disarmAbort() on prompt/abort_and_prompt frames (see
  // src/proxy.js upstream path) — mirrored here directly.
  bridge.handleDownstreamFrame('{"type":"prompt","message":"next turn"}');
  bridge.disarmAbort();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"c2","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"c2","id":"fresh","index":0,"status":"running","agent":"scout"}}');
  assert.deepEqual(cancels, [], 'disarmed: new-turn children are never cancelled');
  assert.equal(bridge.pendingCount(), 1, 'new-turn child counts as pending work');
});
