'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { shimVersionInfo } = require('../src/cli.js');

test('shimVersionInfo splits pi base from iteration counter', () => {
  const info = shimVersionInfo('1.3.0-1');
  assert.equal(info.piBase, '1.3.0');
  assert.equal(info.iteration, '1');
  assert.equal(info.full, '1.3.0-1');

  const plain = shimVersionInfo('1.3.0');
  assert.equal(plain.piBase, '1.3.0');
  assert.equal(plain.iteration, '0');

  // 4-segment and malformed versions are rejected (npm could never publish them)
  assert.equal(shimVersionInfo('1.3.0.1'), null);
  assert.equal(shimVersionInfo('banana'), null);
});

test('package version follows the <pi>-<iteration> scheme', () => {
  const info = shimVersionInfo();
  assert.ok(info, `package.json version "${pkg.version}" must match <pi>-<iter>`);
  const [major, minor, patch] = info.piBase.split('.').map(Number);
  // Gate floor: T3 requires >= 0.80.5
  assert.ok(
    major > 0 || minor > 80 || (minor === 80 && patch >= 5),
    'reported pi base must satisfy T3 MINIMUM_PI_VERSION 0.80.5'
  );
});
