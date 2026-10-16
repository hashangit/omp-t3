'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

test('Proxy pipeline passes through turn_end with usage metrics byte-for-byte', async () => {
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

  const turnEndFrame = JSON.stringify({
    type: 'turn_end',
    turn: 1,
    usage: {
      input: 7348,
      output: 42,
      cacheRead: 384,
      cacheWrite: 0,
      totalTokens: 7774,
      cost: { total: 0.000725 }
    }
  });

  childOut.write(turnEndFrame + '\n');
  await new Promise((r) => setImmediate(r));

  assert.equal(clientLines.lines.length, 1);
  assert.equal(clientLines.lines[0], turnEndFrame);

  pipeline.stop();
});
