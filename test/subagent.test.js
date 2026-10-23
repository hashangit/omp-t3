'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubagentBridge } = require('../src/subagent.js');

test('SubagentBridge renames toolName task to subagent on tool_execution frames', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'call_1',
    toolName: 'task',
    args: { prompt: 'Investigate bug' }
  }));
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.line);
  assert.equal(parsed.type, 'tool_execution_start');
  assert.equal(parsed.toolName, 'subagent');
  assert.equal(parsed.tool, undefined);
});

test('SubagentBridge merges OMP task progress into T3 results entries', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'task',
    result: {
      content: [],
      details: {
        projectAgentsDir: null,
        results: [],
        totalDurationMs: 1,
        progress: [
          { index: 0, id: 'StaticSubagentAnalysis', agent: 'scout', agentSource: 'bundled', modelRole: 'smol', status: 'completed', task: 'Analyze the subagent bridge' },
          { index: 1, id: 'LiveSubagentProbe', agent: 'task', status: 'running', task: 'Probe the shim' },
          { index: 2, id: 'Watcher', agent: 'reviewer', status: 'aborted', task: 'Watch run' },
          { index: 3, id: 'Broken', agent: 'task', status: 'failed', task: 'Fail run' }
        ]
      }
    }
  }));
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.line);
  assert.equal(parsed.toolName, 'subagent');
  const results = parsed.result.details.results;
  assert.equal(results.length, 4);

  assert.equal(results[0].agent, 'scout');
  assert.equal(results[0].task, 'Analyze the subagent bridge');
  assert.equal(results[0].step, 0);
  assert.equal(results[0].finished, true);

  // omp reported this child under the tool name; the bridge re-titles it to
  // the child's id so T3's node is not named after the tool.
  assert.equal(results[1].agent, 'LiveSubagentProbe');
  assert.equal(results[1].finished, undefined);

  assert.equal(results[2].finished, true);
  assert.equal(results[2].stopReason, 'aborted');

  assert.equal(results[3].finished, true);
  assert.equal(results[3].stopReason, 'error');
  assert.equal(results[3].exitCode, 1);
});

test('SubagentBridge normalizes existing results entries to T3 field names', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_2',
    toolName: 'task',
    result: {
      content: [],
      details: {
        results: [{ index: 0, id: 'A', agentSource: 'bundled', status: 'completed', task: 'Do a thing' }]
      }
    }
  });
  const first = bridge.handleDownstreamFrame(raw);
  const parsed = JSON.parse(first.line);
  assert.equal(parsed.result.details.results[0].agent, 'A');
  assert.equal(parsed.result.details.results[0].finished, true);

  // Second pass must leave bytes untouched (no re-rewrite)
  const second = bridge.handleDownstreamFrame(first.line);
  assert.equal(second.handled, false);
});

test('SubagentBridge leaves string-valued mentions of task literals untouched', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({ content: ' debated "name":"task" naming ' });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.handled, false);
});

test('SubagentBridge leaves non-task tool_execution frames untouched', () => {
  const bridge = new SubagentBridge();
  const raw = JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'bash', result: { details: { results: [] } } });
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.handled, false);
});

test('SubagentBridge passes through non-JSON lines without corruption', () => {
  const bridge = new SubagentBridge();
  const raw = 'log: someone said "tool":"task" out loud';
  const res = bridge.handleDownstreamFrame(raw);
  assert.equal(res.handled, false);
});

test('SubagentBridge ignores unrelated frames', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'message_update',
    text_delta: 'Hello'
  }));
  assert.equal(res.handled, false);
});
test('SubagentBridge synthesizes tool_execution_update from subagent frames', () => {
  const bridge = new SubagentBridge();
  // Owner call seen first
  bridge.handleDownstreamFrame(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call_9', toolName: 'task', args: {} }));

  const lc = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_lifecycle',
    payload: { id: 'EchoHi', agent: 'task', parentToolCallId: 'call_9', status: 'started', index: 0 }
  }));
  assert.equal(lc.handled, true);
  const upd = JSON.parse(lc.line);
  assert.equal(upd.type, 'tool_execution_update');
  assert.equal(upd.toolCallId, 'call_9');
  assert.equal(upd.toolName, 'subagent');
  assert.deepEqual(upd.partialResult.details.results, [
    { agent: 'EchoHi', task: '', finished: false, step: 0 }
  ]);

  const pg = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_progress',
    payload: { index: 0, agent: 'task', parentToolCallId: 'call_9', task: 'Say hi', progress: { index: 0, id: 'EchoHi', agent: 'task', status: 'running', task: 'Say hi', recentOutput: 'working on it', resolvedModelIdentity: 'zai/glm-5.3-flash' } }
  }));
  const pgParsed = JSON.parse(pg.line);
  const entry = pgParsed.partialResult.details.results[0];
  assert.equal(entry.agent, 'EchoHi'); // generic 'task' name falls back to id
  assert.equal(entry.task, 'Say hi');
  assert.equal(entry.model, 'zai/glm-5.3-flash');
  assert.equal(entry.finished, false);
  assert.equal(entry.messages[0].content[0].text, 'working on it');

  const ev = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_event',
    payload: { id: 'EchoHi', parentToolCallId: 'call_9', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer text' }] } } }
  }));
  const evParsed = JSON.parse(ev.line);
  assert.equal(evParsed.partialResult.details.results[0].messages[0].content[0].text, 'final answer text');

  const done = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'subagent_lifecycle',
    payload: { id: 'EchoHi', agent: 'task', parentToolCallId: 'call_9', status: 'completed', index: 0 }
  }));
  const doneParsed = JSON.parse(done.line);
  assert.equal(doneParsed.partialResult.details.results[0].finished, true);
});

test('SubagentBridge orders entries by step and suppresses unattachable frames', () => {
  const bridge = new SubagentBridge();
  const orphan = bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_lifecycle', payload: { id: 'X', status: 'started' } }));
  assert.equal(orphan.handled, true);
  assert.equal(orphan.line, undefined); // suppressed, nothing synthesized

  // omp attributes the children to task call c1 - register it as a task tool
  bridge.handleDownstreamFrame(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', args: {} }));
  bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_progress', payload: { index: 1, agent: 'task', parentToolCallId: 'c1', task: 'B', progress: { index: 1, id: 'b2', status: 'running', task: 'B' } } }));
  bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_progress', payload: { index: 0, agent: 'task', parentToolCallId: 'c1', task: 'A', progress: { index: 0, id: 'a1', status: 'running', task: 'A' } } }));
  const upd = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({ type: 'subagent_lifecycle', payload: { id: 'a1', parentToolCallId: 'c1', status: 'completed' } })).line);
  assert.deepEqual(upd.partialResult.details.results.map((r) => r.agent), ['a1', 'b2']);
  assert.deepEqual(upd.partialResult.details.results.map((r) => r.step), [0, 1]);
});

test('SubagentBridge ignores other event types entirely', () => {
  const bridge = new SubagentBridge();
  assert.equal(bridge.handleDownstreamFrame(JSON.stringify({ type: 'session_settled' })).handled, false);
});

test('subagent frames during later tools re-parent to the task call (no orphan nodes)', () => {
  const bridge = new SubagentBridge();
  // task tool starts -> owns the child
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_task1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_task1","id":"child1","index":0,"status":"running"}}');
  // bash and wait start - must NOT steal ownership
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_bash1","toolName":"bash","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_wait1","toolName":"wait","args":{}}');
  // completion frames arrive while wait is active; omp attributes them to wait
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_wait1","id":"child1","index":0,"status":"completed","agent":"CardProbe","task":"probe steps"}}');
  assert.equal(res.handled, true);
  const out = JSON.parse(res.line);
  assert.equal(out.toolCallId, 'call_task1', 'must attach to the task call, not wait/bash');
  assert.equal(out.partialResult.details.results[0].agent, 'CardProbe');
  assert.equal(out.partialResult.details.results[0].finished, true);
  // frames with no parent at all also land on the task call
  const res2 = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"progress":{"id":"child1","index":0,"agent":"CardProbe","task":"probe steps","status":"running","recentOutput":"step 2..."}}}');
  assert.equal(JSON.parse(res2.line).toolCallId, 'call_task1');
});

test('subagent child named after the tool is renamed to its id in task results', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"call_t","toolName":"task","result":{"details":{"results":[{"id":"child9","agent":"task","task":"do things","status":"completed"}]}}}');
  assert.equal(res.handled, true);
  const parsed = JSON.parse(res.line);
  const entry = parsed.result.details.results[0];
  assert.equal(entry.agent, 'child9', 'node title must not be the tool name');
  assert.equal(entry.finished, true);
});

test('subagent state map is pruned when the task tool call ends', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"c1","index":0,"status":"running"}}');
  assert.ok(bridge.subagentsByCall.has('call_t'));
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"call_t","toolName":"task","result":{"content":[{"type":"text","text":"done"}]}}');
  assert.equal(bridge.subagentsByCall.has('call_t'), false, 'ended task call must not hold child state');
});

// --- Feature 002 FR6: narration projection ---

function narrationForLastFrame(bridge, line) {
  const res = bridge.handleDownstreamFrame(line);
  return JSON.parse(res.line).partialResult.details.results[0];
}

test('narration: lastIntent wins over recentOutput while the child is running', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"reader","index":0,"status":"running","agent":"reader"}}');

  // recentOutput alone -> output tail is the text (unchanged legacy behavior)
  const tail = narrationForLastFrame(bridge, '{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"reader","index":0,"status":"running","recentOutput":"working on it"}}}');
  assert.equal(tail.messages[0].content[0].text, 'working on it');

  // omp 18.12.3+ adds lastIntent: it is the child's own step narration and
  // must displace the raw output tail while the child runs.
  const narration = narrationForLastFrame(bridge, '{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"reader","index":0,"status":"running","lastIntent":"compacting the transcript","recentOutput":"working on it"}}}');
  assert.equal(narration.messages[0].content[0].text, 'compacting the transcript');
});

test('narration: finished child shows the final assistant text over the running intent', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"writer","index":0,"status":"running","agent":"writer"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"writer","index":0,"status":"running","lastIntent":"drafting the summary"}}}');
  bridge.handleDownstreamFrame('{"type":"subagent_event","payload":{"parentToolCallId":"call_t","id":"writer","event":{"type":"agent_message","message":{"role":"assistant","content":[{"type":"text","text":"Final answer text"}]}}}}');
  const finished = JSON.parse(bridge.handleDownstreamFrame('{"type":"subagent_event","payload":{"parentToolCallId":"call_t","id":"writer","event":{"type":"agent_end"}}}').line)
    .partialResult.details.results[0];
  assert.equal(finished.finished, true);
  assert.equal(finished.messages[0].content[0].text, 'Final answer text');
});

test('narration: task-result progress items project lastIntent into messages only when absent', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(JSON.stringify({
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
  const [a, b] = JSON.parse(res.line).result.details.results;
  assert.equal(a.messages, undefined, 'no lastIntent: entry shape unchanged');
  assert.equal(b.messages[0].content[0].text, 'scanning deps');
});

// --- Feature 002 FR4: pending count for hold-open notices ---

test('pendingCount counts unfinished children across open task calls', () => {
  const bridge = new SubagentBridge();
  assert.equal(bridge.pendingCount(), 0);
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"running"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c2","index":1,"status":"running"}}');
  // A second, later task call owns another live child
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

test('abortSweep terminalizes unfinished children and returns cancel requests for both sides', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"running","agent":"scout"}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c2","index":1,"status":"completed","agent":"reviewer"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_2","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_2","progress":{"id":"c3","index":0,"status":"running"}}}');

  const sweep = bridge.abortSweep();

  // T3 side: one synthesized update per call with live children. Completed
  // entries keep their own terminal state; live ones become interrupted
  // (finished + stopReason aborted -> T3 status `interrupted`).
  assert.equal(sweep.toClient.length, 2);
  const first = JSON.parse(sweep.toClient[0]);
  assert.equal(first.type, 'tool_execution_update');
  assert.equal(first.toolCallId, 'call_1');
  const byAgent = new Map(first.partialResult.details.results.map((r) => [r.agent, r]));
  assert.equal(byAgent.get('scout').finished, true);
  assert.equal(byAgent.get('scout').stopReason, 'aborted');
  assert.equal(byAgent.get('reviewer').stopReason, undefined, 'already-completed entry is not relabeled');

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

test('FR16: sweep terminalizes children re-attached after their task call ended', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"c1","index":0,"status":"running","agent":"scout"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  // Detached child keeps reporting after the parent's call ended (the
  // live-verified detached-children shape): its entry is re-attached.
  bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"callA","progress":{"id":"c1","index":0,"status":"running"}}}');
  assert.equal(bridge.pendingCount(), 0, 'ended call: count non-authoritative (unchanged pin)');

  const sweep = bridge.abortSweep();
  assert.equal(sweep.toClient.length, 1, 're-attached children of an ended call still terminalize in T3');
  const upd = JSON.parse(sweep.toClient[0]);
  assert.equal(upd.toolCallId, 'callA');
  assert.equal(upd.partialResult.details.results[0].finished, true);
  assert.equal(upd.partialResult.details.results[0].stopReason, 'aborted');
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['c1']);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('subagent_lifecycle failed status maps to a T3 failed entry', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  const res = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"c1","index":0,"status":"failed","agent":"redteam","description":"Adversarial review"}}');
  const parsed = JSON.parse(res.line);
  const entry = parsed.partialResult.details.results[0];
  assert.equal(entry.agent, 'redteam');
  assert.equal(entry.task, 'Adversarial review', 'lifecycle mandates arrive as description, not task');
  assert.equal(entry.finished, true);
  assert.equal(entry.stopReason, 'error');
  assert.equal(entry.exitCode, 1);
});

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
  const entry = update.partialResult.details.results[0];
  assert.equal(entry.agent, 'security-reviewer');
  assert.equal(entry.task, 'Audit the bridge');
  assert.equal(entry.model, 'zai/glm-5.3');
  assert.equal(entry.finished, false);
  assert.equal(entry.messages[0].content[0].text, 'Reading src/proxy.js');

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

test('FR14: six concurrent task calls - explicit parents land true, parentless unknowns mint no card', () => {
  const bridge = new SubagentBridge();
  for (let i = 1; i <= 6; i++) {
    bridge.handleDownstreamFrame(`{"type":"tool_execution_start","toolCallId":"c${i}","toolName":"task","args":{}}`);
  }

  // Explicit parent references are trusted: the child lands on its true call.
  const explicit = JSON.parse(bridge.handleDownstreamFrame(
    '{"type":"subagent_progress","payload":{"parentToolCallId":"c3","progress":{"id":"x3","index":0,"status":"running","task":"true child of c3"}}}'
  ).line);
  assert.equal(explicit.toolCallId, 'c3');
  assert.equal(explicit.partialResult.details.results.length, 1);

  // The incident shape: parentless unknown children while six calls are
  // open. An open call alone is not ownership - nothing is minted.
  const withheld = bridge.handleDownstreamFrame(
    '{"type":"subagent_progress","payload":{"progress":{"id":"ghost","index":4,"status":"running"}}}'
  );
  assert.equal(withheld.handled, true);
  assert.equal(withheld.line, undefined, 'ambiguous update mints no card');
  assert.equal(withheld.refreshRequested, true, 'reconciliation is requested');

  // The withheld child is registered live and unattributed; no call owns it.
  const ghost = bridge.childRegistry.get('ghost');
  assert.equal(ghost.ownerCallId, null);
  assert.equal(ghost.step, undefined);
  assert.equal(ghost.live, true);
  assert.equal(ghost.status, 'running');
  assert.equal(ghost.finished, false);
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
  assert.equal(res.line, undefined, 'no card minted under callB or anywhere');
  assert.equal(bridge.subagentsByCall.size, 0);
  assert.equal(bridge.childRegistry.get('orphan1').ownerCallId, null);
  assert.equal(bridge.childRegistry.get('orphan1').live, true, 'the hidden child stays tracked');

  // FR19: the sweep cancels it even though it was never rendered.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toClient, [], 'withheld children contribute cancellations only');
  const cancels = sweep.toOmp.map((l) => JSON.parse(l));
  assert.deepEqual(cancels.map((c) => c.subagentId), ['orphan1']);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');

  // quickstart §10 item 6: reconciliation re-attributes it when a snapshot
  // carries its parent (callA stays known even though it ended).
  const healed = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-99', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'orphan1', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  assert.ok(healed.emit, 'healed child renders under its true parent');
  assert.equal(JSON.parse(healed.emit.trim()).toolCallId, 'callA');
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
  const upd = JSON.parse(res.line);
  assert.equal(upd.toolCallId, 'callA', 'registry owner wins over the merely-open call');
  assert.equal(upd.partialResult.details.results[0].finished, true);
});

test('FR15: duplicate fleet indices and missing indices get distinct stable steps', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  const steps = [];
  const push = (line) => {
    for (const r of JSON.parse(line).partialResult.details.results) {
      if (!steps.includes(r.step)) steps.push(r.step);
    }
  };
  push(bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"a","index":0,"status":"running"}}').line);
  push(bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"b","index":0,"status":"running"}}').line);
  push(bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"call_1","progress":{"id":"c","status":"running"}}}').line);
  assert.equal(steps.length, 3, 'one distinct node step per child');
});

test('FR15: snapshot index disagreement never renumbers an attached child', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"task","args":{}}');
  const first = JSON.parse(bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_1","id":"kid","index":0,"status":"running"}}'
  ).line);
  assert.equal(first.partialResult.details.results[0].step, 0);

  // A later snapshot claims a different fleet index: same card, same step
  // (the snapshot may enrich the card - here it adds the agent name - but
  // the node identity does not move).
  const again = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 5, agent: 'scout', status: 'running', parentToolCallId: 'call_1' }] }
  });
  assert.ok(again.emit, 'snapshot enrichment still updates the card');
  const refreshed = JSON.parse(again.emit.trim());
  assert.equal(refreshed.toolCallId, 'call_1', 'same parent');
  assert.equal(refreshed.partialResult.details.results.length, 1, 'no second node minted');
  assert.equal(refreshed.partialResult.details.results[0].step, 0, 'step frozen at first attach');
  assert.equal(bridge.subagentsByCall.get('call_1').size, 1);
  assert.equal(bridge.subagentsByCall.get('call_1').get('kid').step, 0);
});

test('FR14: mid-turn attach - explicit parent anchors the card when no task call was ever seen', () => {
  const bridge = new SubagentBridge();
  const res = bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_mid","id":"m1","index":0,"status":"running","agent":"scout"}}'
  );
  const upd = JSON.parse(res.line);
  assert.equal(upd.toolCallId, 'call_mid', 'no task-call history: the explicit parent anchors');
  assert.equal(upd.partialResult.details.results[0].agent, 'scout');
});

test('FR15: tool-result child at index 5 keeps its step when an event later claims index 0', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  // Tool update projects the child at step 5 and registers it.
  const tool = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 5, status: 'running', task: 'T' }] } }
  })).line);
  assert.equal(tool.partialResult.details.results[0].step, 5);
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'call_t');
  assert.equal(bridge.childRegistry.get('kid').step, 5);

  // The later event claims index 0: the frozen step wins, one node only.
  const upd = JSON.parse(bridge.handleDownstreamFrame(
    '{"type":"subagent_progress","payload":{"parentToolCallId":"call_t","progress":{"id":"kid","index":0,"status":"running"}}}'
  ).line);
  assert.equal(upd.partialResult.details.results.length, 1, 'no duplicate card');
  assert.equal(upd.partialResult.details.results[0].step, 5, 'step frozen at first attach');
});

test('FR15: event-attached child keeps its step when a tool result claims another index', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"running"}}');
  const tool = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 5, status: 'running' }] } }
  })).line);
  assert.equal(tool.partialResult.details.results[0].step, 0, 'projected frame adopts the frozen step');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').step, 0);
  assert.equal(bridge.subagentsByCall.get('call_t').size, 1);
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
  assert.equal(sweep.toClient.length, 1, 'its card terminalizes too');
  const upd = JSON.parse(sweep.toClient[0]);
  assert.equal(upd.toolCallId, 'call_t');
  assert.equal(upd.partialResult.details.results[0].finished, true);
  assert.equal(upd.partialResult.details.results[0].stopReason, 'aborted');
  assert.equal(bridge.pendingCount(), 0);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR17: a snapshot re-attaching a finished child restores its terminal state', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"completed"}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_end","toolCallId":"callA","toolName":"task","result":{"content":[]}}');
  assert.equal(bridge.subagentsByCall.has('callA'), false, 'map pruned at call end');

  // A later running snapshot must not resurrect the finished child.
  const res = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  assert.ok(res.emit, 're-attached');
  const entry = JSON.parse(res.emit.trim()).partialResult.details.results[0];
  assert.equal(entry.finished, true, 'terminal state restored, not resurrected as running');
  assert.equal(bridge.childRegistry.get('kid').live, false, 'registry liveness preserved');
  const sweep = bridge.abortSweep();
  assert.equal(sweep.toOmp.length, 0, 'finished children are not re-cancelled');
});

test('FR17: a snapshot after the sweep restores the swept terminal state', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running"}}');
  assert.equal(bridge.abortSweep().toOmp.length, 1);

  const res = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-9', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'running', parentToolCallId: 'callA' }] }
  });
  const entry = JSON.parse(res.emit.trim()).partialResult.details.results[0];
  assert.equal(entry.finished, true);
  assert.equal(entry.stopReason, 'aborted', 'swept outcome survives the snapshot');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] }, 'second sweep is a no-op');
});

test('FR16/FR17: a child completed via tool updates is not re-cancelled or re-aborted', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  const toolFrame = (status) => bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status, task: 'T' }] } }
  })).line;

  assert.notEqual(JSON.parse(toolFrame('running')).partialResult.details.results[0].finished, true);
  assert.equal(JSON.parse(toolFrame('completed')).partialResult.details.results[0].finished, true);
  assert.equal(bridge.childRegistry.get('kid').finished, true);
  assert.equal(bridge.childRegistry.get('kid').live, false);

  // Interrupt after the child already completed: no cancel, no aborted card.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp, [], 'completed children are not cancelled');
  assert.deepEqual(sweep.toClient, [], 'completed cards are not relabeled aborted');
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR15/FR17: a stale running tool update never un-finishes a completed child', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"completed"}}');

  // Stale progress from before the completion crosses the tool channel.
  const stale = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'running', task: 'T' }] } }
  })).line);
  const projected = stale.partialResult.details.results[0];
  assert.equal(projected.finished, true, 'outgoing card stays terminal');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').finished, true, 'tracked entry stays terminal');
  assert.equal(bridge.childRegistry.get('kid').live, false, 'registry liveness not resurrected');
  assert.equal(bridge.childRegistry.get('kid').finished, true);
  assert.equal(bridge.pendingCount(), 0, 'finished child is not counted as pending');

  // And the interrupt agrees: nothing live, nothing to cancel.
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
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
  assert.equal(bridge.subagentsByCall.get('callA').get('kid').step, 0);

  // The same child reported under known task B: conflicting parent —
  // withheld from rendering, reconciliation requested, ownership intact.
  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"running","agent":"scout"}}');
  assert.equal(conflict.line, undefined, 'no second card minted');
  assert.equal(conflict.refreshRequested, true, 'reconciliation requested');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA', 'ownership not renegotiated');
  assert.equal(bridge.subagentsByCall.has('callB'), false, 'no map, no duplicate node');
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

  // The interrupt closes the one real card and cancels the child exactly once.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['kid']);
  assert.equal(sweep.toClient.length, 1);
  assert.equal(JSON.parse(sweep.toClient[0]).toolCallId, 'callA');
});

test('FR15: a conflicting tool-result entry is dropped, adopted nowhere, and reconciled', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  // B's task frame claims the child: dropped from the projection, not
  // tracked under B, reconciliation requested over the existing channel.
  const res = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'callB', toolName: 'task',
    partialResult: { content: [], details: { results: [{ id: 'kid', index: 0, status: 'running', task: 'T' }] } }
  }));
  const projected = JSON.parse(res.line).partialResult.details.results;
  assert.equal(projected.length, 0, 'duplicate entry dropped from the frame');
  assert.equal(res.refreshRequested, true, 'reconciliation requested');
  assert.equal(bridge.subagentsByCall.has('callB'), false, 'no tracked adoption under B');
  assert.equal(bridge.childRegistry.get('kid').ownerCallId, 'callA');
  assert.equal(bridge.subagentsByCall.get('callA').get('kid').finished, false);

  // The child stays cancellable under its real owner.
  const sweep = bridge.abortSweep();
  assert.deepEqual(sweep.toOmp.map((l) => JSON.parse(l).subagentId), ['kid']);
});

test('FR17: a conflicting-parent completion terminalizes the recorded owner card (event path)', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  // The same child completes, reported under conflicting parent B: the
  // update renders nothing under B, but the owner's card terminalizes.
  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"completed"}}');
  assert.equal(conflict.refreshRequested, true);
  assert.ok(conflict.line, 'owner card update emitted');
  const owner = JSON.parse(conflict.line);
  assert.equal(owner.toolCallId, 'callA', 'the update goes to the recorded owner');
  assert.equal(owner.partialResult.details.results[0].finished, true);
  assert.equal(owner.partialResult.details.results[0].stopReason, undefined, 'completed flavor preserved');

  // Sticky: a later conflicting running frame changes nothing.
  const stale = bridge.handleDownstreamFrame('{"type":"subagent_progress","payload":{"parentToolCallId":"callB","progress":{"id":"kid","index":0,"status":"running"}}}');
  assert.equal(stale.line, undefined);
  assert.equal(bridge.subagentsByCall.get('callA').get('kid').finished, true);

  // Registry terminal, live dead: the interrupt neither cancels nor relabels.
  assert.equal(bridge.childRegistry.get('kid').live, false);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR17: a conflicting-parent completion in a snapshot terminalizes the owner card', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const res = bridge.handleBridgeResponse({
    type: 'response', id: 'ompt3-sub-1', command: 'get_subagents', success: true,
    data: { subagents: [{ id: 'kid', index: 0, agent: 'scout', status: 'completed', parentToolCallId: 'callB' }] }
  });
  assert.ok(res.emit, 'owner update emitted from the snapshot path');
  const owner = JSON.parse(res.emit.trim());
  assert.equal(owner.toolCallId, 'callA');
  assert.equal(owner.partialResult.details.results[0].finished, true);
  assert.equal(bridge.subagentsByCall.get('callA').get('kid').finished, true);
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR17: a conflicting tool-channel completion terminalizes the owner card', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const res = bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'callB', toolName: 'task',
    partialResult: { content: [], details: { results: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  }));
  const frames = res.line.trim().split('\n').map((l) => JSON.parse(l));
  const frame = frames.find((f) => f.toolCallId === 'callB');
  const owner = frames.find((f) => f.toolCallId === 'callA');
  assert.equal(frame.partialResult.details.results.length, 0, 'conflicting entry still dropped');
  assert.ok(owner, 'owner card update appended to the outgoing line');
  assert.equal(owner.partialResult.details.results[0].finished, true);
  assert.equal(res.refreshRequested, true);

  // No cancel, no aborted relabel: the child was already completed.
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR17: conflicting failed status carries the error outcome to the owner card', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callA","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"callB","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callA","id":"kid","index":0,"status":"running","agent":"scout"}}');

  const conflict = bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"callB","id":"kid","index":0,"status":"failed"}}');
  const owner = JSON.parse(conflict.line);
  assert.equal(owner.toolCallId, 'callA');
  assert.equal(owner.partialResult.details.results[0].finished, true);
  assert.equal(owner.partialResult.details.results[0].stopReason, 'error');
  assert.equal(owner.partialResult.details.results[0].exitCode, 1);
  assert.equal(bridge.childRegistry.get('kid').stopReason, 'error');
});

test('FR17: a completed tool record after a failed child preserves the error outcome', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  const failed = JSON.parse(bridge.handleDownstreamFrame(
    '{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"failed","agent":"redteam"}}'
  ).line);
  assert.equal(failed.partialResult.details.results[0].stopReason, 'error');
  assert.equal(failed.partialResult.details.results[0].exitCode, 1);

  // Later tool record claims completed: the canonical error outcome wins.
  const tool = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  })).line);
  const projected = tool.partialResult.details.results[0];
  assert.equal(projected.finished, true);
  assert.equal(projected.stopReason, 'error', 'failed outcome not erased by a later completed record');
  assert.equal(projected.exitCode, 1);
  assert.equal(bridge.childRegistry.get('kid').stopReason, 'error');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').stopReason, 'error');

  // The sweep agrees: finished, nothing to cancel or relabel.
  assert.deepEqual(bridge.abortSweep(), { toClient: [], toOmp: [] });
});

test('FR17: a completed tool record after an aborted child preserves interrupted', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame('{"type":"subagent_lifecycle","payload":{"parentToolCallId":"call_t","id":"kid","index":0,"status":"aborted","agent":"scout"}}');
  const tool = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  })).line);
  assert.equal(tool.partialResult.details.results[0].stopReason, 'aborted');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').stopReason, 'aborted');
});

test('FR17: an aborted tool record after a completed child does not relabel it', () => {
  const bridge = new SubagentBridge();
  bridge.handleDownstreamFrame('{"type":"tool_execution_start","toolCallId":"call_t","toolName":"task","args":{}}');
  bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'completed', task: 'T' }] } }
  }));
  const tool = JSON.parse(bridge.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'call_t', toolName: 'task',
    partialResult: { content: [], details: { progress: [{ id: 'kid', index: 0, status: 'aborted', task: 'T' }] } }
  })).line);
  const projected = tool.partialResult.details.results[0];
  assert.equal(projected.finished, true);
  assert.equal(projected.stopReason, undefined, 'canonical completed flavor kept (no interrupted relabel)');
  assert.equal(bridge.subagentsByCall.get('call_t').get('kid').stopReason, undefined);
});
