'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  adaptT3ExtensionArgs,
  deferralLedgerKey,
  readDeferralLedger
} = require('../src/extension_compat.js');

let sqliteAvailable = true;
try {
  // eslint-disable-next-line no-new
  new DatabaseSync(':memory:');
} catch {
  sqliteAvailable = false;
}

test('readDeferralLedger reports data, never throws: db missing', () => {
  const result = readDeferralLedger({
    extensionPath: '/nowhere/compat.ts',
    agentDbPath: path.join(os.tmpdir(), 'omp-t3-no-such-agent.db')
  });
  assert.equal(result.found, false);
  assert.equal(result.deferrable, null);
  assert.ok(result.error);
});

test('readDeferralLedger reports a missing row and a present deferred row', { skip: !sqliteAvailable }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-t3-ledger-'));
  const dbPath = path.join(dir, 'agent.db');
  const compatPath = path.join(dir, 'pi-t3-mcp-extension.compat.ts');
  fs.writeFileSync(compatPath, '// adapted\n'.repeat(32));

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT)');
  db.close();

  // Before omp ever evaluated the extension: no row yet.
  const before = readDeferralLedger({ extensionPath: compatPath, agentDbPath: dbPath });
  assert.equal(before.found, false);
  assert.equal(before.error, null, 'missing row is a clean "not yet", not a failure');

  // omp's row: { fingerprint: "<size>:<mtimeMs>", deferrable: true }
  const stat = fs.statSync(compatPath);
  const writer = new DatabaseSync(dbPath);
  writer.prepare('INSERT INTO cache (key, value) VALUES (?, ?)').run(
    deferralLedgerKey(compatPath),
    JSON.stringify({ fingerprint: `${stat.size}:${stat.mtimeMs}`, deferrable: true })
  );
  writer.close();

  const after = readDeferralLedger({ extensionPath: compatPath, agentDbPath: dbPath });
  assert.equal(after.found, true);
  assert.equal(after.deferrable, true);
  assert.equal(after.fingerprintMatches, true, 'fingerprint must match the current compat copy');

  // Stale fingerprint (file changed after the two launches): informational
  fs.writeFileSync(compatPath, '// adapted + touched\n');
  const stale = readDeferralLedger({ extensionPath: compatPath, agentDbPath: dbPath });
  assert.equal(stale.found, true);
  assert.equal(stale.deferrable, true);
  assert.equal(stale.fingerprintMatches, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readDeferralLedger flags a row that never became deferrable', { skip: !sqliteAvailable }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-t3-ledger-'));
  const dbPath = path.join(dir, 'agent.db');
  const compatPath = path.join(dir, 'compat.ts');
  fs.writeFileSync(compatPath, '// x\n');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO cache (key, value) VALUES (?, ?)').run(
    deferralLedgerKey(compatPath),
    JSON.stringify({ fingerprint: '1:1', deferrable: false })
  );
  db.close();

  const result = readDeferralLedger({ extensionPath: compatPath, agentDbPath: dbPath });
  assert.equal(result.deferrable, false, '--check renders WARN for eager loading');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extension adaptation still targets the compat copy whose ledger is checked', async () => {
  // Ties FR12's ledger check to the path the proxy actually launches: the
  // adapted copy key must be the same file adaptT3ExtensionArgs rewrites to.
  const source = [
    'export const handler = (pi) => {',
    '  const commands = pi.getCommands().filter((command) => command.source === "skill");',
    '  // ...',
    '};'
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-t3-adapt-'));
  const extPath = path.join(dir, 'pi-t3-mcp-extension.ts');
  fs.writeFileSync(extPath, source);

  const cachePath = path.join(dir, 'cache', 'pi-t3-mcp-extension.compat.ts');
  const { args, extensionPath } = await adaptT3ExtensionArgs(
    ['--mode', 'rpc-ui', '--extension', extPath],
    { cachePath }
  );
  assert.equal(extensionPath, cachePath);
  assert.ok(args.includes(cachePath));
  fs.rmSync(dir, { recursive: true, force: true });
});
