'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/cli.js');

test('parseArgs rewrites --mode rpc to --mode rpc-ui', () => {
  const result = parseArgs(['--mode', 'rpc', '--session', 'abc-123']);
  assert.equal(result.action, 'proxy');
  assert.deepEqual(result.ompArgs, ['--mode', 'rpc-ui', '--session', 'abc-123']);
});

test('parseArgs rewrites --mode=rpc to --mode=rpc-ui', () => {
  const result = parseArgs(['--mode=rpc', '--hide-thinking']);
  assert.equal(result.action, 'proxy');
  assert.deepEqual(result.ompArgs, ['--mode=rpc-ui', '--hide-thinking']);
});

test('parseArgs defaults to --mode rpc-ui when no mode is supplied (zero-flag UX)', () => {
  const result = parseArgs([]);
  assert.equal(result.action, 'proxy');
  assert.deepEqual(result.ompArgs, ['--mode', 'rpc-ui']);
});

test('parseArgs preserves custom flags and ordering', () => {
  const result = parseArgs(['--session', 'xyz', '--mode', 'rpc', '--fork', 'prev-1']);
  assert.equal(result.action, 'proxy');
  assert.deepEqual(result.ompArgs, ['--session', 'xyz', '--mode', 'rpc-ui', '--fork', 'prev-1']);
});

test('parseArgs detects helper flags', () => {
  assert.equal(parseArgs(['--version']).action, 'version');
  assert.equal(parseArgs(['-v']).action, 'version');
  assert.equal(parseArgs(['--help']).action, 'help');
  assert.equal(parseArgs(['--check']).action, 'check');
  assert.equal(parseArgs(['--setup-symlink']).action, 'setup-symlink');
});
