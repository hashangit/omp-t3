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
