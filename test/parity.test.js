'use strict';

// Feature 002 regression pins against the merged contract (FR1/FR4/FR10/FR11):
// frames the consumer needs verbatim keep crossing the bridge byte-identically.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

function linesByType(collected, type) {
  return collected.getJson().filter((f) => f && f.type === type);
}

function startPipeline() {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const client = collectLines(clientOut);
  const toChild = collectLines(childIn);
  pipeline.start();
  return { pipeline, clientIn, childIn, childOut, client, toChild };
}

test('FR11 pin: fork/switch_session upstream and get_entries responses cross byte-identically', async () => {
  const { childOut, clientIn, client, toChild } = startPipeline();

  // Upstream: the consumer's rollback/fork launch-state frames must reach omp
  // exactly as sent (no translation — omp handles them natively).
  const switchSession = JSON.stringify({ type: 'switch_session', sessionPath: '/tmp/s/x.jsonl', id: 'r-1' });
  const fork = JSON.stringify({ type: 'fork', fromSession: '/tmp/s/x.jsonl', id: 'r-2' });
  clientIn.write(switchSession + '\n');
  clientIn.write(fork + '\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(toChild.lines, [switchSession, fork], 'both directions stay byte-identical');

  // Downstream: a full get_entries response (entry history of a compacted
  // session) passes untouched — history integrity is omp's, not the bridge's.
  const getEntries = JSON.stringify({
    type: 'response',
    command: 'get_entries',
    success: true,
    data: { entries: [{ id: 'e1', type: 'text', text: 'before compaction' }] }
  });
  childOut.write(getEntries + '\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(client.lines, [getEntries]);
});

test('FR4 pipeline: hold-open notice lands in-thread and does not repeat until the state changes', async () => {
  const { clientIn, childOut, client } = startPipeline();

  // A turn is active so the consumer renders notices
  clientIn.write(JSON.stringify({ type: 'prompt', message: 'start a dev server' }) + '\n');
  childOut.write(JSON.stringify({ type: 'agent_start' }) + '\n');
  childOut.write(JSON.stringify({ type: 'agent_end', isTerminal: false }) + '\n');
  childOut.write(JSON.stringify({ type: 'prompt_result', status: 'completed', agentInvoked: true, sessionSettled: false }) + '\n');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const notices = linesByType(client, 'extension_ui_request').filter((f) => f.method === 'notify');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, 'Run held open: pending background work');
  assert.equal(notices[0].notifyType, 'info');

  // T3's settle probes with pending work: no duplicate notice
  childOut.write(JSON.stringify({ type: 'response', command: 'get_state', success: true, data: { isStreaming: false, queuedMessageCount: 0, hasPendingAsyncWork: true } }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(linesByType(client, 'extension_ui_request').filter((f) => f.method === 'notify').length, 1);

  // Drain -> settle: hold clears; the next withheld turn notices again
  childOut.write(JSON.stringify({ type: 'response', command: 'get_state', success: true, data: { isStreaming: false, queuedMessageCount: 0, hasPendingAsyncWork: false } }) + '\n');
  childOut.write(JSON.stringify({ type: 'session_settled' }) + '\n');
  await new Promise((r) => setImmediate(r));
  const settledCount = linesByType(client, 'agent_settled').length;
  assert.equal(settledCount, 1, 'settle translation still happens exactly once');

  clientIn.write(JSON.stringify({ type: 'prompt', message: 'again, pending' }) + '\n');
  childOut.write(JSON.stringify({ type: 'prompt_result', status: 'completed', agentInvoked: true, sessionSettled: false }) + '\n');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(linesByType(client, 'extension_ui_request').filter((f) => f.method === 'notify').length, 2, 'fresh hold interval emits again');
});

test('FR4 pipeline: hold-open notice states the subagent count only when the bridge knows it', async () => {
  const { clientIn, childOut, client } = startPipeline();

  clientIn.write(JSON.stringify({ type: 'prompt', message: 'spawn subagents' }) + '\n');
  childOut.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call_x', toolName: 'task', args: {} }) + '\n');
  childOut.write(JSON.stringify({ type: 'subagent_lifecycle', payload: { parentToolCallId: 'call_x', id: 'sub1', index: 0, status: 'running', agent: 'scout' } }) + '\n');
  childOut.write(JSON.stringify({ type: 'subagent_lifecycle', payload: { parentToolCallId: 'call_x', id: 'sub2', index: 1, status: 'running', agent: 'scout' } }) + '\n');
  childOut.write(JSON.stringify({ type: 'prompt_result', status: 'completed', agentInvoked: true, sessionSettled: false }) + '\n');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const notices = linesByType(client, 'extension_ui_request').filter((f) => f.method === 'notify');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, 'Run held open: 2 pending subagents');
});
