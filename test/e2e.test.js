'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

test('E2E: Full turn lifecycle from prompt to agent_settled', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();

  const pipeline = createProxyPipeline({
    clientIn,
    clientOut,
    childIn,
    childOut
  });

  const clientLines = collectLines(clientOut);
  const childLines = collectLines(childIn);
  pipeline.start();

  // 1. T3 Code initializes and asks for available models
  clientIn.write('{"type": "get_available_models", "id": "req-init"}\n');
  await new Promise((r) => setImmediate(r));

  // Verify get_available_models was intercepted and NOT sent to child
  assert.equal(childLines.lines.length, 0);
  assert.equal(clientLines.lines.length, 1);
  const modelResp = JSON.parse(clientLines.lines[0]);
  assert.equal(modelResp.id, 'req-init');
  assert.equal(modelResp.command, 'get_available_models');
  assert.equal(modelResp.success, true);
  assert.ok(modelResp.models.length > 0);

  // 2. T3 Code sends prompt
  const promptFrame = '{"type": "prompt", "message": "Write a hello world function"}';
  clientIn.write(promptFrame + '\n');
  await new Promise((r) => setImmediate(r));

  assert.equal(childLines.lines.length, 1);
  assert.equal(childLines.lines[0], promptFrame);

  // 3. Child OMP streams turn_start, text_delta, thinking_delta
  childOut.write('{"type": "turn_start", "turn": 1}\n');
  childOut.write('{"type": "message_update", "thinking_delta": "Planning code..."}\n');
  childOut.write('{"type": "message_update", "text_delta": "function hello() { return \\"hello\\"; }"}\n');
  childOut.write('{"type": "turn_end", "turn": 1, "usage": {"input": 100, "output": 25}}\n');
  await new Promise((r) => setImmediate(r));

  // 4. Child OMP outputs prompt_result (completed) followed by session_settled
  childOut.write('{"type": "prompt_result", "status": "completed"}\n');
  childOut.write('{"type": "session_settled"}\n');
  await new Promise((r) => setImmediate(r));

  // Verify client received all streaming frames, prompt_result suppressed, and session_settled converted to agent_settled
  const clientParsed = clientLines.getJson();
  const types = clientParsed.map((f) => f.type);

  assert.ok(types.includes('turn_start'));
  assert.ok(types.includes('message_update'));
  assert.ok(types.includes('turn_end'));
  assert.ok(!types.includes('prompt_result'), 'prompt_result must be suppressed from T3');
  assert.ok(!types.includes('session_settled'), 'session_settled must be converted');
  assert.ok(types.includes('agent_settled'), 'agent_settled must be emitted to T3');

  const settleFrame = clientParsed.find((f) => f.type === 'agent_settled');
  assert.equal(settleFrame.aborted, false);

  pipeline.stop();
});

test('E2E: Aborted turn triggers agent_settled with aborted: true', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();

  const pipeline = createProxyPipeline({
    clientIn,
    clientOut,
    childIn,
    childOut
  });

  const clientLines = collectLines(clientOut);
  pipeline.start();

  // Send prompt then abort
  clientIn.write('{"type": "prompt", "message": "Long generation"}\n');
  clientIn.write('{"type": "abort"}\n');
  await new Promise((r) => setImmediate(r));

  // Child reports aborted prompt_result and session_settled
  childOut.write('{"type": "prompt_result", "status": "aborted"}\n');
  childOut.write('{"type": "session_settled"}\n');
  await new Promise((r) => setImmediate(r));

  const clientParsed = clientLines.getJson();
  const settleFrame = clientParsed.find((f) => f.type === 'agent_settled');
  assert.ok(settleFrame, 'agent_settled must be emitted');
  assert.equal(settleFrame.aborted, true);

  pipeline.stop();
});

test('E2E: Upstream set_model normalizes redundant provider prefix before forwarding to child', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();

  const pipeline = createProxyPipeline({
    clientIn,
    clientOut,
    childIn,
    childOut
  });

  const childLines = collectLines(childIn);
  pipeline.start();

  // T3 sends double-prefixed set_model from old thread state
  clientIn.write('{"type": "set_model", "provider": "openrouter", "modelId": "openrouter/deepseek/deepseek-v4.1-flash"}\n');
  await new Promise((r) => setImmediate(r));

  assert.equal(childLines.lines.length, 1);
  const forwarded = JSON.parse(childLines.lines[0]);
  assert.equal(forwarded.type, 'set_model');
  assert.equal(forwarded.provider, 'openrouter');
  assert.equal(forwarded.modelId, 'deepseek/deepseek-v4.1-flash');

  // When modelId is already clean, it passes through untouched
  clientIn.write('{"type": "set_model", "provider": "openrouter", "modelId": "deepseek/deepseek-v4.1-flash"}\n');
  await new Promise((r) => setImmediate(r));

  assert.equal(childLines.lines.length, 2);
  const forwarded2 = JSON.parse(childLines.lines[1]);
  assert.equal(forwarded2.modelId, 'deepseek/deepseek-v4.1-flash');

  pipeline.stop();
});

test('E2E: child ready frame triggers set_subagent_subscription upstream', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const childLines = collectLines(childIn);
  pipeline.start();

  childOut.write('{"type":"ready","version":"18.11.3"}\n');
  await new Promise((r) => setImmediate(r));
  pipeline.stop();

  const sent = childLines.getJson();
  const sub = sent.find((f) => f.type === 'set_subagent_subscription');
  assert.ok(sub, 'subscription must be requested once ready');
  assert.equal(sub.level, 'events');
});

test('E2E: manual compact renders synthesized compaction cards and forwards response', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const clientLines = collectLines(clientOut);
  const childLines = collectLines(childIn);
  const pipeline = createProxyPipeline({
    clientIn,
    clientOut,
    childIn,
    childOut
  });
  pipeline.start();

  // T3 sends a manual compact request
  clientIn.write('{"id":"c1","type":"compact","customInstructions":"Keep it brief."}\n');
  await new Promise((r) => setImmediate(r));

  // Frame must reach omp untouched, and T3 must get a compaction_start card
  assert.equal(childLines.lines.length, 1);
  assert.ok(childLines.lines[0].includes('"type":"compact"'));
  const start = JSON.parse(clientLines.lines[0]);
  assert.equal(start.type, 'compaction_start');

  // omp answers after compacting (single response, no compaction events)
  childOut.write('{"id":"c1","type":"response","command":"compact","success":true,"data":{"summary":"Compacted the session.","tokensBefore":4200}}\n');
  await new Promise((r) => setImmediate(r));

  // T3 gets compaction_end followed by the original response
  assert.equal(clientLines.lines.length, 3);
  const end = JSON.parse(clientLines.lines[1]);
  assert.equal(end.type, 'compaction_end');
  assert.equal(end.result.summary, 'Compacted the session.');
  assert.equal(end.result.tokensBefore, 4200);
  const fwd = JSON.parse(clientLines.lines[2]);
  assert.equal(fwd.command, 'compact');
  assert.equal(fwd.success, true);
});

test('E2E: get_commands serves OMP catalog and skills reach the Pi dialect', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const clientLines = collectLines(clientOut);
  const childLines = collectLines(childIn);
  pipeline.start();

  // OMP pushes its catalog at startup; T3 must never see the raw frame.
  childOut.write(JSON.stringify({
    type: 'available_commands_update',
    commands: [
      { name: 'context', description: 'Show context usage', source: 'builtin' },
      { name: 'skill:commit', description: 'Commit staged changes', source: 'skill' }
    ]
  }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(clientLines.lines.length, 0);

  // T3 polls get_commands; the bridge answers from cache without touching OMP.
  clientIn.write('{"id":"probe-1","type":"get_commands"}\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(childLines.lines.length, 0); // served from cache
  assert.equal(clientLines.lines.length, 1);
  const resp = JSON.parse(clientLines.lines[0]);
  assert.equal(resp.id, 'probe-1');
  assert.equal(resp.command, 'get_commands');
  assert.equal(resp.success, true);
  assert.deepEqual(resp.data.commands, [
    { name: 'context', description: 'Show context usage', source: 'extension' },
    { name: 'skill:commit', description: 'Commit staged changes', source: 'skill' }
  ]);
});

test('E2E: cold get_commands triggers one injected refresh and answers', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const clientLines = collectLines(clientOut);
  const childLines = collectLines(childIn);
  pipeline.start();

  clientIn.write('{"id":5,"type":"get_commands"}\n');
  await new Promise((r) => setImmediate(r));

  // One get_available_commands injected into OMP, no answer to T3 yet.
  assert.equal(childLines.lines.length, 1);
  const injected = JSON.parse(childLines.lines[0]);
  assert.match(injected.id, /^ompt3-cmds-\d+$/);
  assert.equal(clientLines.lines.length, 0);

  // OMP responds; T3 gets its translated answer and the raw response is suppressed.
  childOut.write(JSON.stringify({
    id: injected.id, type: 'response', success: true,
    data: { commands: [{ name: 'stats', description: 'Stats dashboard', source: 'builtin' }] }
  }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(childLines.lines.length, 1); // no further traffic to OMP
  assert.equal(clientLines.lines.length, 1);
  const resp = JSON.parse(clientLines.lines[0]);
  assert.equal(resp.id, 5);
  assert.deepEqual(resp.data.commands, [
    { name: 'stats', description: 'Stats dashboard', source: 'extension' }
  ]);
});

test('E2E: local slash command renders output and settles the turn', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const clientLines = collectLines(clientOut);
  pipeline.start();

  // T3 runs /context as a prompt; OMP echoes the prompt through.
  clientIn.write('{"id":77,"type":"prompt","message":"/context"}\n');
  await new Promise((r) => setImmediate(r));

  // OMP streams command output, then completes locally.
  childOut.write(JSON.stringify({ type: 'command_output', text: '\x1b[32mContext window:\x1b[39m 1% used' }) + '\n');
  childOut.write('{"id":77,"type":"response","command":"prompt","success":true,"data":{"agentInvoked":false}}\n');
  await new Promise((r) => setImmediate(r));

  const frames = clientLines.lines.map((l) => JSON.parse(l));
  const rendered = frames.find((f) => f.type === 'message_update');
  assert.ok(rendered, 'command output must render inside the turn');
  assert.equal(rendered.assistantMessageEvent.type, 'text_end');
  assert.match(rendered.assistantMessageEvent.content, /^```/);
  assert.match(rendered.assistantMessageEvent.content, /Context window: 1% used/);

  const response = frames.find((f) => f.type === 'response' && f.id === 77);
  assert.ok(response, 'prompt response must still reach T3');
  assert.equal(response.data.agentInvoked, false);

  const settled = frames[frames.length - 1];
  assert.equal(settled.type, 'agent_settled');
  assert.equal(settled.aborted, false);
});

test('E2E: turn with pending background work settles per cycle, no hang', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const clientLines = collectLines(clientOut);
  pipeline.start();

  // 1. Main prompt cycle: omp streams, ends the cycle non-terminal, and
  //    reports sessionSettled:false because a background job is still running.
  //    No session_settled follows until that job drains.
  clientIn.write('{"id":1,"type":"prompt","message":"start sleep 90 in background"}\n');
  await new Promise((r) => setImmediate(r));
  childOut.write('{"type":"agent_start"}\n');
  childOut.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Backgrounded as job bg_1."}}\n');
  childOut.write('{"type":"tool_execution_start","toolCallId":"call_bg1","toolName":"bash","args":{"command":"sleep 90"}}\n');
  childOut.write('{"type":"tool_execution_end","toolCallId":"call_bg1"}\n');
  childOut.write('{"type":"agent_end","isTerminal":false}\n');
  childOut.write('{"type":"prompt_result","status":"completed","agentInvoked":true,"sessionSettled":false}\n');
  await new Promise((r) => setImmediate(r));

  let frames = clientLines.lines.map((l) => JSON.parse(l));
  let types = frames.map((f) => f.type);
  assert.ok(types.includes('agent_end'), 'agent_end must pass through');
  assert.equal(types.filter((t) => t === 'agent_settled').length, 1, 'cycle 1 must settle exactly once');
  assert.ok(!types.includes('session_settled'), 'no session_settled reached T3');
  assert.ok(!types.includes('prompt_result'), 'prompt_result stays suppressed');
  const firstSettle = frames.filter((f) => f.type === 'agent_settled')[0];
  assert.equal(firstSettle.aborted, false);

  // 2. Steer cycle: omp answers the steer, ends the cycle, still no
  //    session_settled (job pending). The turn must settle again.
  clientIn.write('{"id":2,"type":"steer","message":"Done?"}\n');
  await new Promise((r) => setImmediate(r));
  childOut.write('{"type":"agent_start"}\n');
  childOut.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Yes, done."}}\n');
  childOut.write('{"type":"agent_end","isTerminal":false}\n');
  await new Promise((r) => setImmediate(r));

  frames = clientLines.lines.map((l) => JSON.parse(l));
  types = frames.map((f) => f.type);
  assert.equal(types.filter((t) => t === 'agent_settled').length, 2, 'steer cycle must settle exactly once more');

  // 3. Wake cycle: background job drained, omp delivers the result and the
  //    wrap-up ends terminal with session_settled.
  childOut.write('{"type":"agent_start"}\n');
  childOut.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Job bg_1 finished."}}\n');
  childOut.write('{"type":"agent_end","isTerminal":true}\n');
  childOut.write('{"type":"session_settled"}\n');
  await new Promise((r) => setImmediate(r));

  frames = clientLines.lines.map((l) => JSON.parse(l));
  types = frames.map((f) => f.type);
  // Cycle synthesis + the translated session_settled both land for the wake
  // cycle. The duplicate is deliberate: T3's settle probe is generation-
  // guarded and finalizes once, and the extra settle keeps the translation
  // path intact for adopted-wake replay buffers.
  assert.equal(types.filter((t) => t === 'agent_settled').length, 4, 'wake cycle settles via synthesis + translation');
  assert.ok(types.includes('session_settled') === false, 'session_settled is always translated, never forwarded');
  assert.equal(types[types.length - 1], 'agent_settled');

  pipeline.stop();
});
