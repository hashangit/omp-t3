'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  adaptT3ExtensionArgs,
  GET_COMMANDS_MARKER,
  GET_COMMANDS_REPLACEMENT
} = require('../src/extension_compat.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes a synthetic T3 extension containing the exact known marker. */
function writeT3Extension(dir, name = 'pi-t3-mcp-extension.ts') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    'import { stripFrontmatter } from "@earendil-works/pi-coding-agent";',
    'export default async function t3McpExtension(pi: ExtensionAPI) {',
    '  ' + GET_COMMANDS_MARKER,
    '  pi.on("input", async (event, ctx) => {',
    '    const path = command.sourceInfo.path;',
    '  });',
    '}'
  ].join('\n'));
  return file;
}

test('rewrites the T3 extension argv entry to the adapted cache copy', async () => {
  const dir = makeTempDir('omp-t3-adapt-src-');
  const cachePath = path.join(makeTempDir('omp-t3-adapt-cache-'), 'compat.ts');
  try {
    const original = writeT3Extension(dir);
    const { args, extensionPath } = await adaptT3ExtensionArgs(
      ['--mode', 'rpc-ui', '--extension', original],
      { cachePath, log: () => {} }
    );
    assert.strictEqual(extensionPath, cachePath);
    assert.deepStrictEqual(args, ['--mode', 'rpc-ui', '--extension', cachePath]);
    const adapted = fs.readFileSync(cachePath, 'utf8');
    assert.ok(!adapted.includes(GET_COMMANDS_MARKER), 'marker must be replaced');
    assert.ok(adapted.includes(GET_COMMANDS_REPLACEMENT), 'replacement must be present');
    assert.ok(adapted.includes('const path = command.sourceInfo.path;'), 'rest of source preserved');
    assert.strictEqual(fs.readFileSync(original, 'utf8').includes(GET_COMMANDS_MARKER), true, 'original untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  }
});

test('handles the --extension=<path> form and leaves other extensions untouched', async () => {
  const dir = makeTempDir('omp-t3-adapt-src-');
  const cachePath = path.join(makeTempDir('omp-t3-adapt-cache-'), 'compat.ts');
  try {
    const t3 = writeT3Extension(dir);
    const userExtension = path.join(dir, 'my-own-extension.ts');
    fs.writeFileSync(userExtension, 'export default function mine(pi) {}');
    const { args, extensionPath } = await adaptT3ExtensionArgs(
      ['--extension=' + t3, '--extension', userExtension],
      { cachePath, log: () => {} }
    );
    assert.strictEqual(extensionPath, cachePath);
    assert.deepStrictEqual(args, ['--extension=' + cachePath, '--extension', userExtension]);
    assert.strictEqual(fs.existsSync(path.join(path.dirname(cachePath), 'my-own-extension.ts')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  }
});

test('passes the original through with a warning when the source drifts', async () => {
  const dir = makeTempDir('omp-t3-adapt-src-');
  const cachePath = path.join(makeTempDir('omp-t3-adapt-cache-'), 'compat.ts');
  const warnings = [];
  try {
    const drifted = path.join(dir, 'pi-t3-mcp-extension.ts');
    fs.writeFileSync(drifted, 'export default async function t3McpExtension(pi) { pi.getCommands(); }');
    const { args, extensionPath } = await adaptT3ExtensionArgs(
      ['--extension', drifted],
      { cachePath, log: (message) => warnings.push(message) }
    );
    assert.strictEqual(extensionPath, null);
    assert.deepStrictEqual(args, ['--extension', drifted]);
    assert.strictEqual(fs.existsSync(cachePath), false);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /no longer matches the known source/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  }
});

test('unreadable extension files are passed through with a warning', async () => {
  const missing = path.join(makeTempDir('omp-t3-adapt-gone-'), 'pi-t3-mcp-extension.ts');
  const cachePath = path.join(makeTempDir('omp-t3-adapt-cache-'), 'compat.ts');
  const warnings = [];
  try {
    const { args, extensionPath } = await adaptT3ExtensionArgs(
      ['--extension', missing],
      { cachePath, log: (message) => warnings.push(message) }
    );
    assert.strictEqual(extensionPath, null);
    assert.deepStrictEqual(args, ['--extension', missing]);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Cannot read T3 extension/);
  } finally {
    fs.rmSync(path.dirname(missing), { recursive: true, force: true });
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  }
});

test('repeated adaptation is idempotent and keeps the cache in sync with the source', async () => {
  const dir = makeTempDir('omp-t3-adapt-src-');
  const cacheDir = makeTempDir('omp-t3-adapt-cache-');
  const cachePath = path.join(cacheDir, 'compat.ts');
  try {
    const original = writeT3Extension(dir);
    const first = await adaptT3ExtensionArgs(['--extension', original], { cachePath, log: () => {} });
    const snapshot = fs.readFileSync(cachePath, 'utf8');

    // Source update (T3 refreshes its cache file) must propagate. Each shim
    // launch starts from T3's original argv, so re-run with the original path.
    fs.writeFileSync(original, fs.readFileSync(original, 'utf8') + '\n// upstream tweak\n');
    const second = await adaptT3ExtensionArgs(['--extension', original], { cachePath, log: () => {} });
    assert.strictEqual(second.extensionPath, cachePath);
    assert.notStrictEqual(fs.readFileSync(cachePath, 'utf8'), snapshot);
    assert.ok(fs.readFileSync(cachePath, 'utf8').includes(GET_COMMANDS_REPLACEMENT));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ignores dangling --extension flags and unrelated basenames', async () => {
  const warnings = [];
  const cachePath = path.join(makeTempDir('omp-t3-adapt-cache-'), 'compat.ts');
  try {
    const { args, extensionPath } = await adaptT3ExtensionArgs(
      ['--extension', '--no-title', '--extension', '/tmp/some-other.ts'],
      { cachePath, log: (message) => warnings.push(message) }
    );
    assert.strictEqual(extensionPath, null);
    assert.deepStrictEqual(args, ['--extension', '--no-title', '--extension', '/tmp/some-other.ts']);
    assert.strictEqual(warnings.length, 0);
  } finally {
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  }
});
