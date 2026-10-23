'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { detectInstallChannel, channelUpdateCommand, updateSelf } = require('../src/updater.js');

const NPM_ROOT = path.join(os.tmpdir(), 'fake-npm-global', 'lib', 'node_modules');

test('US8: checkout installs are guidance-only, never an error', () => {
  const checkout = path.join(os.tmpdir(), 'omp-t3-checkout-test', 'bin', 'omp-t3.js');
  const info = detectInstallChannel({ execPath: checkout, npmGlobalRoot: NPM_ROOT });
  assert.equal(info.channel, 'checkout');
  assert.equal(info.realpath, checkout);
  assert.equal(channelUpdateCommand('checkout'), 'git -C <checkout> pull && npm install');
});

test('US8: npm-global installs detect the npm channel', () => {
  const npmBin = path.join(NPM_ROOT, 'omp-t3', 'bin', 'omp-t3.js');
  const info = detectInstallChannel({ execPath: npmBin, npmGlobalRoot: NPM_ROOT });
  assert.equal(info.channel, 'npm');
  assert.equal(channelUpdateCommand('npm'), 'npm update -g omp-t3');
});

test('US8: homebrew installs detect the brew channel without consulting npm', () => {
  const brewBin = '/opt/homebrew/bin/omp-t3.js';
  const info = detectInstallChannel({ execPath: brewBin, npmGlobalRoot: NPM_ROOT });
  assert.equal(info.channel, 'homebrew');
  assert.equal(info.npmGlobalRoot, null, 'no npm subprocess for brew installs');
  assert.equal(channelUpdateCommand('homebrew'), 'brew upgrade hashangit/omp-t3/omp-t3');
});

test('US8: $HOMEBREW_PREFIX counts as a brew prefix', () => {
  const prefix = path.join(os.tmpdir(), 'fake-homebrew');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const target = path.join(prefix, 'bin', 'omp-t3.js');
  fs.writeFileSync(target, '// fake\n');

  const original = process.env.HOMEBREW_PREFIX;
  process.env.HOMEBREW_PREFIX = prefix;
  try {
    const info = detectInstallChannel({ execPath: target, npmGlobalRoot: null });
    assert.equal(info.channel, 'homebrew');
  } finally {
    if (original === undefined) delete process.env.HOMEBREW_PREFIX;
    else process.env.HOMEBREW_PREFIX = original;
    fs.rmSync(path.join(prefix, 'bin'), { recursive: true, force: true });
  }
});

test('US8: default update [--self] is a successful no-op with manual guidance', () => {
  const result = updateSelf({
    execPath: path.join(os.tmpdir(), 'checkout', 'omp-t3.js'),
    npmGlobalRoot: NPM_ROOT
  });
  assert.equal(result.exitCode, 0, 'T3 provider maintenance treats failures as WARN; no-op must exit 0');
  assert.equal(result.ran, false);
  assert.equal(result.channel, 'checkout');
  const text = result.lines.join('\n');
  assert.ok(text.includes('Nothing was changed'));
  assert.ok(text.includes('git -C <checkout> pull && npm install'), 'exact manual command shown');
});

test('US8: --yes opt-in still stays advisory for a bare checkout', () => {
  const result = updateSelf({
    run: true,
    execPath: path.join(os.tmpdir(), 'checkout2', 'omp-t3.js'),
    npmGlobalRoot: NPM_ROOT
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.ran, false, 'there is no package manager to delegate to');
});

test('US8: --yes propagates the package-manager update and its exit code', () => {
  const calls = [];
  const result = updateSelf({
    run: true,
    execPath: path.join(NPM_ROOT, 'omp-t3', 'bin', 'omp-t3.js'),
    npmGlobalRoot: NPM_ROOT,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    }
  });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{ cmd: 'npm', args: ['update', '-g', 'omp-t3'], opts: { stdio: 'inherit' } }]);

  const failed = updateSelf({
    run: true,
    execPath: path.join(NPM_ROOT, 'omp-t3', 'bin', 'omp-t3.js'),
    npmGlobalRoot: NPM_ROOT,
    spawn: () => ({ status: 1 })
  });
  assert.equal(failed.exitCode, 1, 'real failures surface (after a deliberate opt-in)');
  assert.ok(failed.lines.join('\n').includes('exited 1'), 'manual fallback command echoed');
});

test('US8: --yes for homebrew runs the tap formula', () => {
  const calls = [];
  updateSelf({
    run: true,
    execPath: '/opt/homebrew/bin/omp-t3.js',
    npmGlobalRoot: null,
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    }
  });
  assert.deepEqual(calls, [{ cmd: 'brew', args: ['upgrade', 'hashangit/omp-t3/omp-t3'] }]);
});
