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

// --- Feature 002 US8: self-update subcommand ---

test('parseArgs routes update (T3 provider maintenance form) to a no-op intent', () => {
  const plain = parseArgs(['update', '--self']);
  assert.equal(plain.action, 'update');
  assert.equal(plain.options.self, true);
  assert.equal(plain.options.yes, false);

  const bare = parseArgs(['update']);
  assert.equal(bare.action, 'update');
  assert.equal(bare.options.self, false);
});

test('parseArgs only applies the package-manager path with --yes', () => {
  const optIn = parseArgs(['update', '--self', '--yes']);
  assert.equal(optIn.options.yes, true);
  assert.equal(optIn.options.self, true);
});

// --- Feature 002 FR1 pin: session continuation flags pass through ---

test('FR1 pin: --session and --fork launch arguments forward byte-identically', () => {
  // omp accepts --session <path> natively (verified against 18.12.6); the
  // bridge only rewrites --mode. Both forms must survive untouched.
  const spaced = parseArgs(['--session', '/tmp/s.jsonl', '--fork', 'other.jsonl']);
  assert.equal(spaced.action, 'proxy');
  assert.deepEqual(spaced.ompArgs, ['--mode', 'rpc-ui', '--session', '/tmp/s.jsonl', '--fork', 'other.jsonl']);

  const separate = parseArgs(['--session=/tmp/x.jsonl']);
  assert.ok(separate.ompArgs.includes('--session=/tmp/x.jsonl'), 'no rewrite of the value path');
});
