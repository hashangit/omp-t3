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
