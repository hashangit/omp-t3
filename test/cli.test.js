'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/cli.js');

// This file pins the STOCK launch rewrite (byte-parity). Delegation
// enforcement is default-on; it is covered by delegate-enforcement.test.js.
process.env.OMPT3_DELEGATE_TASKS = '0';

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

// --- Opt-in subagent concurrency cap (OMPT3_MAX_SUBAGENTS) ---

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subagentOverlayPath, subagentCapArgs } = require('../src/cli.js');

/** Runs fn with a temp XDG_CACHE_HOME and OMPT3_MAX_SUBAGENTS set/restored. */
function withCapEnv(rawValue, fn) {
  const prevCache = process.env.XDG_CACHE_HOME;
  const prevCap = process.env.OMPT3_MAX_SUBAGENTS;
  process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-cap-'));
  if (rawValue === undefined) delete process.env.OMPT3_MAX_SUBAGENTS;
  else process.env.OMPT3_MAX_SUBAGENTS = rawValue;
  try {
    return fn();
  } finally {
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevCache;
    if (prevCap === undefined) delete process.env.OMPT3_MAX_SUBAGENTS;
    else process.env.OMPT3_MAX_SUBAGENTS = prevCap;
  }
}

test('subagentCapArgs: no env var injects nothing (default launch stays byte-identical)', () => {
  assert.deepEqual(withCapEnv(undefined, () => subagentCapArgs(undefined)), []);
  assert.deepEqual(withCapEnv(undefined, () => subagentCapArgs('')), []);
  const argv = withCapEnv(undefined, () => parseArgs(['--mode', 'rpc', '--session', 'abc']).ompArgs);
  assert.deepEqual(argv, ['--mode', 'rpc-ui', '--session', 'abc']);
});

test('subagentCapArgs: valid value writes the task.maxConcurrency overlay and injects --config', () => {
  withCapEnv('2', () => {
    const args = subagentCapArgs('2');
    const overlayPath = subagentOverlayPath(2);
    assert.deepEqual(args, ['--config', overlayPath]);
    assert.equal(fs.readFileSync(overlayPath, 'utf8'), 'task:\n  maxConcurrency: 2\n');
    // End-to-end through the launch translator: T3's `--mode rpc` spawn
    // carries the injected overlay after the mode rewrite.
    const argv = parseArgs(['--mode', 'rpc']).ompArgs;
    assert.deepEqual(argv, ['--mode', 'rpc-ui', '--config', overlayPath]);
  });
});

test('subagentCapArgs: non-decimal and padded values are rejected (plain positive integer only)', () => {
  for (const bad of ['0', '-3', '2.5', 'abc', '0x10', '1e3', ' 5 ', '5\n']) {
    const args = withCapEnv(bad, () => subagentCapArgs(bad));
    assert.deepEqual(args, [], `'${JSON.stringify(bad)}' must inject nothing`);
  }
});

test('subagentCapArgs: invalid value warns on stderr with the value sanitized', () => {
  const original = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    withCapEnv('bad\u0007', () => subagentCapArgs('bad\u0007'));
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1, 'exactly one warning');
  assert.ok(seen[0].includes('bad?'), 'control characters are masked, not echoed raw');
  assert.ok(seen[0].includes('OMPT3_MAX_SUBAGENTS'));
});

test('subagentCapArgs: unwritable cache dir warns and launches without the cap', () => {
  // Point XDG_CACHE_HOME at a FILE: creating <file>/omp-t3/ must fail
  // (ENOTDIR), exercising the availability-over-enforcement path.
  const blocker = path.join(os.tmpdir(), `ompt3-blocker-${process.pid}`);
  fs.writeFileSync(blocker, 'x');
  const prevCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = blocker;
  const prevCap = process.env.OMPT3_MAX_SUBAGENTS;
  process.env.OMPT3_MAX_SUBAGENTS = '2';
  const original = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    assert.deepEqual(subagentCapArgs('2'), [], 'no injection when the overlay cannot be written');
  } finally {
    console.error = original;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevCache;
    if (prevCap === undefined) delete process.env.OMPT3_MAX_SUBAGENTS;
    else process.env.OMPT3_MAX_SUBAGENTS = prevCap;
    fs.rmSync(blocker, { force: true });
  }
  assert.equal(seen.length, 1, 'failure surfaced on stderr, never a crash');
  assert.ok(seen[0].includes('launching without the cap'));
});

test('subagentCapArgs: distinct caps get distinct overlay files (concurrent shims do not fight)', () => {
  withCapEnv('2', () => {
    assert.equal(subagentOverlayPath(2), path.join(path.dirname(subagentOverlayPath(2)), 'subagent-limits-2.yml'));
    assert.notEqual(subagentOverlayPath(2), subagentOverlayPath(5));
  });
});
