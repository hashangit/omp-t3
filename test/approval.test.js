'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

test('Proxy pipeline forwards extension_ui_request downstream and extension_ui_response upstream untouched', async () => {
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

  // OMP emits extension_ui_request
  const approvalReq = JSON.stringify({
    type: 'extension_ui_request',
    id: 'dlg-1',
    method: 'confirm',
    params: { message: 'Allow bash command "rm -rf tmp"?' }
  });
  childOut.write(approvalReq + '\n');

  // Wait tick for readline processing
  await new Promise((r) => setImmediate(r));

  assert.equal(clientLines.lines.length, 1);
  assert.equal(clientLines.lines[0], approvalReq);

  // T3 Code responds with extension_ui_response
  const approvalRes = JSON.stringify({
    type: 'extension_ui_response',
    id: 'dlg-1',
    response: { confirmed: true }
  });
  clientIn.write(approvalRes + '\n');

  await new Promise((r) => setImmediate(r));

  assert.equal(childLines.lines.length, 1);
  assert.equal(childLines.lines[0], approvalRes);

  pipeline.stop();
});
